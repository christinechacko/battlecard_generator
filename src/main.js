/*
  ============================================================
  IMPORTS
  
  We import the official Anthropic JavaScript SDK instead of
  calling the API directly with fetch(). A direct fetch() from
  the browser is blocked by CORS — Anthropic's servers reject
  browser-originated requests for security reasons. The SDK
  handles this by setting dangerouslyAllowBrowser: true, which
  tells it to proceed anyway. This is acceptable for a portfolio
  demo but means the API key is visible in the browser's dev
  tools. We accept that tradeoff here and will address it in
  production via server-side proxying.
  ============================================================
*/
import Anthropic from '@anthropic-ai/sdk';

/*
  ============================================================
  ANTHROPIC CLIENT

  Instantiated once at the top level so it's reused across
  calls. The API key is pulled from the Vite environment at
  build time — Vite replaces import.meta.env.VITE_* references
  with the actual values from your .env file when it bundles
  the code. This means the key is baked into the JS bundle
  that ships to the browser, which is why it's visible in
  dev tools.
  ============================================================
*/
const anthropic = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY,
  dangerouslyAllowBrowser: true,
});

/*
  ============================================================
  STORAGE KEYS

  We use localStorage to persist two things across sessions:
  1. Custom competitors/products the user adds via the UI
  2. Saved battlecards

  Built-in data always comes from the JSON files, never from
  localStorage. This prevents stale cached data from
  overriding updates to the JSON files.
  ============================================================
*/
const CUSTOM_COMPETITORS_KEY = 'battlecard-custom-competitors';
const CUSTOM_PRODUCTS_KEY    = 'battlecard-custom-products';
const SAVED_KEY              = 'saved-battlecards';

/*
  ============================================================
  ICP (IDEAL CUSTOMER PROFILE) LOOKUP TABLES

  CUSTOMER_LABELS — verbose descriptions injected into the
  AI prompt so the model understands the buyer context in
  detail. More context = more relevant battlecard output.

  CUSTOMER_DISPLAY — short human-readable labels used in the
  UI (dropdown options, battlecard headers, saved card metadata).
  ============================================================
*/
const CUSTOMER_LABELS = {
  sporting_venue:    'a sporting venue or stadium (B2B contract buyer)',
  university:        'a university or college campus (B2B contract buyer)',
  movie_theater:     'a movie theater chain (B2B contract buyer)',
  airline:           'an airline or airport concession operator (B2B contract buyer)',
  hospital:          'a hospital or healthcare cafeteria (B2B contract buyer)',
  convenience_store: 'a convenience store or gas station chain (B2B contract buyer)',
  restaurant_chain:  'a restaurant or fast food chain (B2B contract buyer)',
  general_consumer:  'a general consumer making a personal purchase decision',
};

const CUSTOMER_DISPLAY = {
  sporting_venue:    'Sporting venue / stadium',
  university:        'University / campus',
  movie_theater:     'Movie theater chain',
  airline:           'Airline / airport',
  hospital:          'Hospital / healthcare',
  convenience_store: 'Convenience store / gas station',
  restaurant_chain:  'Restaurant / fast food chain',
  general_consumer:  'General consumer',
};

/*
  ============================================================
  IN-MEMORY DATA STORE

  _competitors and _products are module-level variables that
  hold the data fetched from the JSON files. They're populated
  once on page load by loadData() and then read throughout the
  session. We use module-level variables (not localStorage) for
  built-in data so that edits to the JSON files are always
  reflected on the next page load with no cache to clear.
  ============================================================
*/
let _competitors = [];
let _products    = [];

/*
  ============================================================
  DATA LOADING

  Fetches both JSON files in parallel using Promise.all(),
  which is faster than fetching them sequentially. The files
  live in /public/data/ in the Vite project, which Vite serves
  at the root path — so /data/competitors.json resolves
  correctly both in local dev and on GitHub Pages.
  ============================================================
*/
async function loadData() {
  try {
    const [compRes, prodRes] = await Promise.all([
      fetch('/data/competitors.json'),
      fetch('/data/products.json'),
    ]);
    _competitors = await compRes.json();
    _products    = await prodRes.json();
  } catch (e) {
    console.error('Failed to load JSON data files:', e);
  }
}

/*
  ============================================================
  DATA GETTERS

  Each getter merges two sources:
  1. Built-in data from the JSON files (in _competitors / _products)
  2. Custom additions the user saved to localStorage

  The spread operator [...a, ...b] creates a new array with
  all items from both sources. Built-ins come first so they
  always appear at the top of lists and dropdowns.
  ============================================================
*/
function getCustomCompetitors() {
  // localStorage stores data as strings, so we parse the JSON back
  // into an array. If the key doesn't exist or is malformed, return
  // an empty array so the rest of the app doesn't break.
  try { return JSON.parse(localStorage.getItem(CUSTOM_COMPETITORS_KEY)) || []; }
  catch { return []; }
}

function getCustomProducts() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRODUCTS_KEY)) || []; }
  catch { return []; }
}

function getCompetitors() {
  // Always re-reads localStorage so additions appear immediately
  // without needing a page reload.
  return [..._competitors, ...getCustomCompetitors()];
}

function getProducts() {
  return [..._products, ...getCustomProducts()];
}

function getSavedBattlecards() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; }
  catch { return []; }
}

function saveBattlecards(data) {
  // JSON.stringify converts the array back to a string for storage.
  // localStorage can only store strings, not objects or arrays.
  localStorage.setItem(SAVED_KEY, JSON.stringify(data));
}

/*
  ============================================================
  TAB SWITCHER

  All four tab content divs exist in the HTML at all times.
  showTab() hides all of them and then shows only the one
  matching the clicked tab. It also toggles the 'active' CSS
  class on the tab buttons to update the underline indicator.

  We attach this to window so it's accessible from the inline
  onclick attributes in the HTML (e.g. onclick="showTab('generate')").
  ES modules are scoped by default and wouldn't be accessible
  from inline handlers otherwise.
  ============================================================
*/
window.showTab = function(name) {
  ['generate', 'products', 'competitors', 'saved'].forEach((t, i) => {
    // Show the matching tab div, hide all others
    document.getElementById('tab-' + t).style.display = t === name ? 'block' : 'none';
    // Toggle the active class on the corresponding tab button
    document.querySelectorAll('.tab')[i].classList.toggle('active', t === name);
  });

  // Trigger a fresh render when switching to data tabs so the
  // list always reflects the latest localStorage state
  if (name === 'competitors') renderCompetitorList();
  if (name === 'products')    renderProductList();
  if (name === 'saved')       renderSavedList();
};

/*
  ============================================================
  COMPETITOR DROPDOWN (GENERATE TAB)

  Populates the <select> on the Generate tab with all
  competitors (built-in + custom). Called on page load and
  again after a new competitor is added so the dropdown stays
  in sync without a page reload.
  ============================================================
*/
function renderCompetitorDropdown() {
  const competitors = getCompetitors();
  const sel = document.getElementById('competitor-select');
  if (!competitors.length) {
    sel.innerHTML = '<option value="">No competitors loaded</option>';
    return;
  }
  // Map each competitor object to an <option> element.
  // The value is the competitor's ID so we can look up the
  // full object when the user hits Generate.
  sel.innerHTML = competitors.map(c =>
    `<option value="${c.id}">${c.name} — ${c.brand}</option>`
  ).join('');
}

/*
  ============================================================
  COMPETITORS TAB — LIST VIEW

  Renders the full competitor database as a list of cards.
  Custom-added competitors get a "Custom" badge; built-in ones
  show their product type. We detect custom entries by checking
  if the ID starts with 'custom-', which is the prefix we
  assign when a user adds one via the form.
  ============================================================
*/
function renderCompetitorList() {
  const competitors = getCompetitors();
  const list = document.getElementById('competitor-list');
  if (!competitors.length) {
    list.innerHTML = '<p class="empty-state">No competitors loaded.</p>';
    return;
  }
  // Template literals let us build HTML strings with embedded
  // JS expressions. Each competitor becomes a card div.
  list.innerHTML = competitors.map(c => `
    <div class="db-item">
      <div>
        <div class="db-item-name">${c.name}</div>
        <div class="db-item-meta">${c.brand} &middot; ${c.type}</div>
        ${c.claims ? `<div class="db-item-claims">${c.claims}</div>` : ''}
      </div>
      <span class="badge ${c.id.startsWith('custom-') ? 'badge-new' : ''}">
        ${c.id.startsWith('custom-') ? 'Custom' : c.type}
      </span>
    </div>
  `).join('');
}

/*
  ============================================================
  COMPETITORS TAB — ADD NEW

  Reads form field values, validates that the required field
  (name) is present, then appends the new entry to the custom
  competitors array in localStorage. We use Date.now() to
  generate a unique ID — it returns the current timestamp in
  milliseconds, which is unique enough for this use case.

  After saving, we re-render both the list and the dropdown
  so the new entry appears immediately everywhere.
  ============================================================
*/
window.addCompetitor = function() {
  const name   = document.getElementById('new-name').value.trim();
  const brand  = document.getElementById('new-brand').value.trim();
  const type   = document.getElementById('new-type').value;
  const claims = document.getElementById('new-claims').value.trim();
  const target = document.getElementById('new-target').value.trim();

  const errEl     = document.getElementById('add-error');
  const successEl = document.getElementById('add-success');
  errEl.style.display     = 'none';
  successEl.style.display = 'none';

  if (!name) {
    errEl.textContent = 'Competitor name is required.';
    errEl.style.display = 'block';
    return;
  }

  // Read existing custom competitors, append the new one, save back
  const custom = getCustomCompetitors();
  custom.push({
    id:     'custom-' + Date.now(),
    name,
    brand:  brand || 'Unknown',
    type,
    claims: claims || '',
    target: target || 'General market',
  });
  localStorage.setItem(CUSTOM_COMPETITORS_KEY, JSON.stringify(custom));

  // Clear all form fields after a successful save
  ['new-name', 'new-brand', 'new-claims', 'new-target'].forEach(id => {
    document.getElementById(id).value = '';
  });

  // Re-render so the new entry is immediately visible
  renderCompetitorDropdown();
  renderCompetitorList();
  successEl.style.display = 'block';
  setTimeout(() => { successEl.style.display = 'none'; }, 3000);
};

/*
  ============================================================
  PRODUCTS TAB — LIST VIEW

  Same pattern as renderCompetitorList(). Reads all products
  (built-in + custom) and renders them as cards. The badge
  shows 'Custom' for user-added products and the product type
  for built-in ones.
  ============================================================
*/
function renderProductList() {
  const products = getProducts();
  const list = document.getElementById('product-list');
  if (!products.length) {
    list.innerHTML = '<p class="empty-state">No products loaded.</p>';
    return;
  }
  list.innerHTML = products.map(p => `
    <div class="db-item">
      <div>
        <div class="db-item-name">${p.name}</div>
        <div class="db-item-meta">${p.brand} &middot; ${p.type}</div>
        ${p.claims ? `<div class="db-item-claims">${p.claims}</div>` : ''}
      </div>
      <span class="badge ${p.id.startsWith('custom-') ? 'badge-new' : ''}">
        ${p.id.startsWith('custom-') ? 'Custom' : p.type}
      </span>
    </div>
  `).join('');
}

/*
  ============================================================
  PRODUCTS TAB — ADD NEW

  Same pattern as addCompetitor(). Saves the new product to
  the custom products array in localStorage and re-renders
  the list.
  ============================================================
*/
window.addProduct = function() {
  const name   = document.getElementById('new-product-name').value.trim();
  const type   = document.getElementById('new-product-category').value;
  const claims = document.getElementById('new-product-description').value.trim();

  const errEl     = document.getElementById('add-product-error');
  const successEl = document.getElementById('add-product-success');
  errEl.style.display     = 'none';
  successEl.style.display = 'none';

  if (!name) {
    errEl.textContent = 'Product name is required.';
    errEl.style.display = 'block';
    return;
  }

  const custom = getCustomProducts();
  custom.push({
    id:     'custom-' + Date.now(),
    name,
    brand:  'The Coca-Cola Company',
    type,
    claims: claims || '',
    target: '',
  });
  localStorage.setItem(CUSTOM_PRODUCTS_KEY, JSON.stringify(custom));

  document.getElementById('new-product-name').value        = '';
  document.getElementById('new-product-description').value = '';

  renderProductList();
  successEl.style.display = 'block';
  setTimeout(() => { successEl.style.display = 'none'; }, 3000);
};

/*
  ============================================================
  SAVED BATTLECARDS TAB — LIST VIEW

  Renders all saved battlecards as collapsible rows. Each row
  shows the competitor name, ICP, and date in the header.
  Clicking a row calls toggleSavedCard() to expand/collapse
  the full battlecard content.

  The delete button uses e.stopPropagation() to prevent the
  click from bubbling up to the row's onclick handler, which
  would try to toggle the card open/closed at the same time
  as deleting it.
  ============================================================
*/
function renderSavedList() {
  const saved = getSavedBattlecards();
  const list  = document.getElementById('saved-list');
  if (!saved.length) {
    list.innerHTML = '<p class="empty-state">No saved battlecards yet. Generate one and hit Save.</p>';
    return;
  }
  list.innerHTML = saved.map((bc, i) => `
    <div class="saved-item" onclick="toggleSavedCard(${i})">
      <div class="saved-item-header">
        <div>
          <div class="db-item-name">${bc.inputs.competitorName} vs Coca-Cola</div>
          <div class="db-item-meta">${CUSTOMER_DISPLAY[bc.inputs.icpKey] || bc.inputs.icpKey} &middot; ${new Date(bc.createdAt).toLocaleDateString()}</div>
        </div>
        <span class="expand-icon">▼</span>
      </div>
      <div class="saved-item-body" id="saved-body-${i}" style="display:none">
        <div class="section-card">
          <div class="section-title">Positioning statement</div>
          <div class="section-content">${bc.output.positioningStatement}</div>
        </div>
        <div class="win-lose-row">
          <div class="section-card win">
            <div class="section-title">Where we win</div>
            <div class="section-content"><ul>${bc.output.whereWeWin.map(p => `<li>${p}</li>`).join('')}</ul></div>
          </div>
          <div class="section-card lose">
            <div class="section-title">Where we lose</div>
            <div class="section-content"><ul>${bc.output.whereWeLose.map(p => `<li>${p}</li>`).join('')}</ul></div>
          </div>
        </div>
        <div class="section-card">
          <div class="section-title">Objection handling</div>
          <div class="section-content">
            ${bc.output.objectionHandling.map(o => `
              <div class="objection-item">
                <div class="objection-q">"${o.objection}"</div>
                <div class="objection-a">${o.response}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="section-card">
          <div class="section-title">Discovery questions</div>
          <div class="section-content"><ul>${bc.output.discoveryQuestions.map(q => `<li>${q}</li>`).join('')}</ul></div>
        </div>
        ${bc.output.recommendedProduct ? `
        <div class="section-card">
          <div class="section-title">Recommended Coke product</div>
          <div class="section-content">
            <strong>${bc.output.recommendedProduct.name}</strong>
            <p style="margin-top:6px">${bc.output.recommendedProduct.messaging}</p>
          </div>
        </div>` : ''}
        ${bc.output.combatDisinterest ? `
        <div class="section-card">
          <div class="section-title">If they say they're happy with ${bc.inputs.competitorName}</div>
          <div class="section-content">${bc.output.combatDisinterest}</div>
        </div>` : ''}
        <button class="btn-danger" onclick="deleteSavedCard(event, ${i})">Delete</button>
      </div>
    </div>
  `).join('');
}

window.toggleSavedCard = function(i) {
  const body = document.getElementById(`saved-body-${i}`);
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
};

window.deleteSavedCard = function(e, i) {
  // Stop the click from also triggering toggleSavedCard on the parent div
  e.stopPropagation();
  const saved = getSavedBattlecards();
  saved.splice(i, 1); // Remove the item at index i
  saveBattlecards(saved);
  renderSavedList();
};

/*
  ============================================================
  GENERATE BATTLECARD

  This is the core function. It:
  1. Reads the selected competitor and ICP from the UI
  2. Picks the best Coke product to recommend for that ICP
  3. Builds a detailed prompt with all that context
  4. Calls the Anthropic API via the SDK
  5. Parses the JSON response
  6. Renders each section of the battlecard into the DOM
  7. Stores the result on window._currentBattlecard so the
     Save button can access it without re-calling the API
  ============================================================
*/
window.generateBattlecard = async function() {
  const competitorId = document.getElementById('competitor-select').value;
  const icpKey       = document.getElementById('customer-select').value;

  const errEl = document.getElementById('gen-error');
  errEl.style.display = 'none';

  if (!competitorId) {
    errEl.textContent = 'Please select a competitor.';
    errEl.style.display = 'block';
    return;
  }

  // Look up the full competitor object using the ID from the dropdown
  const competitor = getCompetitors().find(c => c.id === competitorId);
  if (!competitor) return;

  /*
    PRODUCT RECOMMENDATION LOGIC
    
    We extract the first word of the ICP display label (e.g. "Sporting"
    from "Sporting venue / stadium") and check if any Coke product's
    target field mentions that word. This is a simple string-match
    heuristic — good enough for demo purposes. If nothing matches,
    we fall back to the first product in the list (Coca-Cola Classic).
  */
  const products = getProducts();
  const icpLabel = CUSTOMER_DISPLAY[icpKey].split('/')[0].trim().toLowerCase();
  const recommended = products.find(p =>
    p.target && p.target.toLowerCase().includes(icpLabel)
  ) || products[0];

  // Update UI to show loading state while we wait for the API
  document.getElementById('battlecard-output').style.display  = 'none';
  document.getElementById('battlecard-loading').style.display = 'block';
  document.getElementById('generate-btn').disabled            = true;
  document.getElementById('save-confirm').style.display       = 'none';

  /*
    PROMPT ENGINEERING

    The prompt is structured into labeled sections so the model
    understands exactly what role it's playing, what data it has,
    and what output format we expect. Key decisions:

    - We tell it to return ONLY valid JSON with no markdown or
      explanation — this makes the response easy to parse without
      regex hacks or error-prone text extraction.
    - We inject the buyer type in plain English so every output
      section is tailored to that specific buyer, not generic.
    - We include the recommended product so the model can
      reference it specifically in its messaging guidance.
    - We ask for combat_disinterest separately from objection
      handling because it's a different sales motion — handling
      "we're already happy" is different from handling a specific
      product concern.
  */
  const prompt = `You are a competitive intelligence expert helping Coca-Cola's sales team win deals.

COCA-COLA CONTEXT:
- World's most recognized beverage brand with unmatched global distribution
- Full portfolio serving every occasion and buyer type
- For B2B buyers: dedicated account management, equipment installation and maintenance, co-marketing support, volume pricing, brand credibility that drives consumer preference
- For consumers: decades of trust, taste consistency, universal availability, emotional connection
- Strong sustainability, community investment, and ESG programs

RECOMMENDED COCA-COLA PRODUCT TO LEAD WITH:
Name: ${recommended.name}
Type: ${recommended.type}
Positioning: ${recommended.claims}
Best for: ${recommended.target}

COMPETITOR BEING ANALYZED:
Name: ${competitor.name}
Brand: ${competitor.brand}
Type: ${competitor.type}
Their claims: ${competitor.claims}
Their target: ${competitor.target}

THE REP IS SELLING TO: ${CUSTOMER_LABELS[icpKey]}

Generate a battlecard tailored specifically to this buyer. Every section must reflect what matters to THIS buyer, not a generic audience.

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{
  "positioning_statement": "2-3 sentences positioning Coca-Cola against ${competitor.name} specifically for this buyer",
  "where_we_win": ["buyer-specific advantage 1", "advantage 2", "advantage 3", "advantage 4"],
  "where_we_lose": ["honest weakness 1 vs ${competitor.name} for this buyer", "weakness 2", "weakness 3"],
  "objection_handling": [
    {"objection": "specific objection this buyer would raise", "response": "how to respond"},
    {"objection": "second objection", "response": "response"},
    {"objection": "third objection", "response": "response"}
  ],
  "discovery_questions": ["question to surface a win with this buyer", "second question", "third question"],
  "recommended_product_messaging": "2-3 sentences on why ${recommended.name} is the right product to lead with for this specific buyer and how to pitch it",
  "combat_disinterest": "2-3 sentences on what to say if this buyer says they are happy with ${competitor.name} and see no reason to switch"
}`;

  try {
    /*
      API CALL VIA SDK

      anthropic.messages.create() sends the prompt to Claude and
      waits for the full response. We use the claude-sonnet model
      for a good balance of quality and speed. max_tokens caps the
      response length — 1500 is enough for a full battlecard.

      The SDK returns a structured object, not raw JSON, so we
      don't need to call response.json() like we would with fetch().
    */
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    /*
      RESPONSE PARSING

      The API returns an array of content blocks. We grab the text
      from the first block. Even though we asked for pure JSON,
      we strip any accidental markdown backticks defensively before
      parsing. If the JSON is malformed, JSON.parse() will throw
      and we'll catch it below.
    */
    const raw     = message.content[0].text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const bc      = JSON.parse(cleaned);

    // Store the full result on window so saveBattlecard() can
    // access it without us needing to re-call the API
    window._currentBattlecard = { competitor, icpKey, bc, recommended };

    /*
      DOM RENDERING

      We inject the parsed data into the pre-existing HTML elements
      by ID. Arrays (where_we_win, etc.) become <ul> lists.
      Objection handling pairs become stacked divs. Everything else
      is plain text or innerHTML.
    */
    document.getElementById('bc-title').textContent = `${competitor.name} vs Coca-Cola`;
    document.getElementById('bc-meta').textContent  = CUSTOMER_DISPLAY[icpKey];

    document.getElementById('bc-positioning').textContent = bc.positioning_statement;

    document.getElementById('bc-win').innerHTML =
      '<ul>' + bc.where_we_win.map(p => `<li>${p}</li>`).join('') + '</ul>';

    document.getElementById('bc-lose').innerHTML =
      '<ul>' + bc.where_we_lose.map(p => `<li>${p}</li>`).join('') + '</ul>';

    document.getElementById('bc-objections').innerHTML =
      bc.objection_handling.map(o => `
        <div class="objection-item">
          <div class="objection-q">"${o.objection}"</div>
          <div class="objection-a">${o.response}</div>
        </div>
      `).join('');

    document.getElementById('bc-discovery').innerHTML =
      '<ul>' + bc.discovery_questions.map(q => `<li>${q}</li>`).join('') + '</ul>';

    document.getElementById('bc-recommended').innerHTML =
      `<strong>${recommended.name}</strong><p style="margin-top:6px">${bc.recommended_product_messaging}</p>`;

    // Dynamically update the label to name the specific competitor
    document.getElementById('bc-combat-label').textContent =
      `If they say they're happy with ${competitor.name}`;
    document.getElementById('bc-combat').innerHTML = bc.combat_disinterest;

    // Show the output and scroll to it
    document.getElementById('battlecard-output').style.display = 'block';
    document.getElementById('battlecard-output').scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (e) {
    errEl.textContent = 'Something went wrong generating the battlecard. Check your API key or try again.';
    errEl.style.display = 'block';
    console.error(e);
  }

  // Always restore the UI regardless of success or failure
  document.getElementById('battlecard-loading').style.display = 'none';
  document.getElementById('generate-btn').disabled = false;
};

/*
  ============================================================
  SAVE BATTLECARD

  Takes the battlecard stored on window._currentBattlecard and
  writes it to localStorage in the canonical schema defined in
  the project spec. We use unshift() instead of push() so the
  newest battlecard appears at the top of the saved list.

  The saved schema separates inputs (what the user selected)
  from output (what the AI generated), which makes it easy to
  display metadata in the list view and full content on expand.
  ============================================================
*/
window.saveBattlecard = function() {
  const current = window._currentBattlecard;
  if (!current) return; // Nothing generated yet, do nothing

  const { competitor, icpKey, bc, recommended } = current;

  const entry = {
    id:        'bc-' + Date.now(),
    createdAt: new Date().toISOString(),
    inputs: {
      competitorId:   competitor.id,
      competitorName: competitor.name,
      icpKey,
      icpLabel: CUSTOMER_DISPLAY[icpKey],
    },
    output: {
      positioningStatement: bc.positioning_statement,
      whereWeWin:           bc.where_we_win,
      whereWeLose:          bc.where_we_lose,
      objectionHandling:    bc.objection_handling,
      discoveryQuestions:   bc.discovery_questions,
      recommendedProduct: {
        id:        recommended.id,
        name:      recommended.name,
        messaging: bc.recommended_product_messaging,
      },
      combatDisinterest: bc.combat_disinterest,
    },
  };

  const saved = getSavedBattlecards();
  saved.unshift(entry); // Add to front so newest appears first
  saveBattlecards(saved);

  document.getElementById('save-confirm').style.display = 'block';
  setTimeout(() => {
    document.getElementById('save-confirm').style.display = 'none';
  }, 3000);
};

/*
  ============================================================
  INIT

  DOMContentLoaded fires when the HTML is fully parsed and the
  DOM is ready to interact with. We wait for it before running
  any DOM queries or data fetches.

  loadData() is async so we await it — this ensures the JSON
  files are fully loaded into _competitors and _products before
  we try to render the competitor dropdown. Without the await,
  the dropdown would render with an empty array and never update.
  ============================================================
*/
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  renderCompetitorDropdown();
});
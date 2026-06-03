// South African PAYE tax (2024/25 brackets). Returns monthly tax after primary rebate.
function calcSATax(monthlyIncome) {
  const annual = monthlyIncome * 12;
  const REBATE = 17235;
  let taxAnnual;
  if      (annual <= 237100)  taxAnnual = annual * 0.18;
  else if (annual <= 370500)  taxAnnual = 42678  + (annual - 237100)  * 0.26;
  else if (annual <= 512800)  taxAnnual = 77362  + (annual - 370500)  * 0.31;
  else if (annual <= 673000)  taxAnnual = 121475 + (annual - 512800)  * 0.36;
  else if (annual <= 857900)  taxAnnual = 179147 + (annual - 673000)  * 0.39;
  else if (annual <= 1817000) taxAnnual = 251258 + (annual - 857900)  * 0.41;
  else                        taxAnnual = 644489 + (annual - 1817000) * 0.45;
  return Math.round(Math.max((taxAnnual - REBATE) / 12, 0) * 100) / 100;
}

function _makePlan(name) {
  return {
    id: 'plan_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    name: name || 'New Plan',
    income:   { categories: [] },
    expenses: { categories: [] }
  };
}

// ─── Supabase client ────────────────────────────────────────────────────────
// SUPABASE_URL and SUPABASE_ANON are injected by supabase-config.js
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── State ──────────────────────────────────────────────────────────────────
const State = {
  // In-memory cache loaded once per page from Supabase
  _cache: null,     // { finance: {...}, savings: [...] }
  _session: null,   // Supabase session object
  _syncTimer: null,

  // ── Auth ──

  getSession: () => State._session,

  getUser: () => {
    const u = State._session?.user;
    return u?.user_metadata?.display_name || u?.email?.split('@')[0] || 'User';
  },

  // Call once at the top of each protected page.
  // Loads the session and user data. Redirects to index.html if not signed in.
  requireAuth: async () => {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return false; }
    State._session = session;
    await State._loadFromDb();
    return true;
  },

  signIn: async (email, password) => {
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    State._session = data.session;
    await State._loadFromDb();
  },

  signUp: async (email, password, displayName) => {
    const { data, error } = await _sb.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } }
    });
    if (error) throw error;
    // After sign-up Supabase may require email confirmation; session may be null
    if (data.session) {
      State._session = data.session;
      await State._loadFromDb();
    }
    return data;
  },

  signOut: async () => {
    await _sb.auth.signOut();
    State._session = null;
    State._cache   = null;
    window.location.href = 'index.html';
  },

  // ── Data ──

  _defaultData: () => {
    const plan = _makePlan('My Plan');
    return {
      finance: { plans: [plan], activePlanId: plan.id },
      savings: []
    };
  },

  _loadFromDb: async () => {
    const userId = State._session.user.id;
    const { data, error } = await _sb
      .from('fintrack_data')
      .select('data')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) { console.error('Load error:', error); State._cache = State._defaultData(); return; }

    if (!data) {
      State._cache = State._defaultData();
      await State._flushToDb();
    } else {
      // Migrate legacy format (finance data at root level)
      const raw = data.data;
      if (raw.plans && !raw.finance) {
        State._cache = { finance: raw, savings: [] };
      } else {
        State._cache = { finance: raw.finance || State._defaultData().finance, savings: raw.savings || [], budgets: raw.budgets || [] };
      }
      // Migrate legacy finance format without plans
      const f = State._cache.finance;
      if (!f.plans) {
        const plan = { id: 'plan_legacy', name: 'My Plan', income: f.income || { categories: [] }, expenses: f.expenses || { categories: [] } };
        State._cache.finance = { plans: [plan], activePlanId: plan.id };
      }
    }
  },

  _flushToDb: async () => {
    const userId = State._session?.user?.id;
    if (!userId || !State._cache) return;
    await _sb.from('fintrack_data').upsert({ user_id: userId, data: State._cache, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  },

  // Debounced save — batches rapid edits into one DB write
  _scheduleSave: () => {
    clearTimeout(State._syncTimer);
    State._syncTimer = setTimeout(() => State._flushToDb(), 800);
  },

  // ── Finance data ──

  getData: () => {
    if (!State._cache) return State._defaultData().finance;
    return State._cache.finance;
  },

  saveData: (data) => {
    if (!State._cache) State._cache = State._defaultData();
    State._cache.finance = data;
    State._scheduleSave();
  },

  getActivePlan: () => {
    const data = State.getData();
    return data.plans.find(p => p.id === data.activePlanId) || data.plans[0];
  },

  // ── Savings data ──

  getSavings: () => {
    if (!State._cache) return [];
    return State._cache.savings || [];
  },

  saveSavings: (savingsArr) => {
    if (!State._cache) State._cache = State._defaultData();
    State._cache.savings = savingsArr;
    State._scheduleSave();
  },

  // ── Budget data ──

  getBudgets: () => {
    if (!State._cache) return [];
    return State._cache.budgets || [];
  },

  getBudget: (monthKey) => {
    return (State._cache?.budgets || []).find(b => b.month === monthKey) || null;
  },

  saveBudget: (budget) => {
    if (!State._cache) State._cache = State._defaultData();
    if (!State._cache.budgets) State._cache.budgets = [];
    const idx = State._cache.budgets.findIndex(b => b.id === budget.id);
    if (idx >= 0) State._cache.budgets[idx] = budget;
    else State._cache.budgets.unshift(budget);
    State._scheduleSave();
  },

  // Clones the active plan's expense categories into a new budget month snapshot
  clonePlanToBudget: (monthKey, planId) => {
    const data = State.getData();
    const plan = (planId && data.plans.find(p => p.id === planId)) || State.getActivePlan();
    const allCats = [...plan.income.categories, ...plan.expenses.categories];

    const grossIncome = plan.income.categories
      .filter(c => !c.disabled)
      .reduce((s, c) => s + c.items.filter(i => !i.disabled && !i.pctMode)
        .reduce((ss, i) => ss + (parseFloat(i.amount) || 0), 0), 0);
    const netIncome = Math.round((grossIncome - calcSATax(grossIncome)) * 100) / 100;

    const categories = plan.expenses.categories
      .filter(c => !c.disabled)
      .map(c => ({
        id: State.genId(),
        planCatId: c.id,
        name: c.name,
        items: c.items
          .filter(i => !i.disabled)
          .map(i => ({
            id: State.genId(),
            planItemId: i.id,
            name: i.name,
            allocatedAmount: State.resolveItemAmt(i, plan),
            type: i.budgetType || 'variable',
            paid: false,
            transactions: []
          }))
      }));

    return {
      id: 'budget_' + monthKey.replace('-', '_'),
      month: monthKey,
      startedAt: new Date().toISOString(),
      planId: plan.id,
      planName: plan.name,
      netIncome,
      categories
    };
  },

  flush: async () => {
    clearTimeout(State._syncTimer);
    await State._flushToDb();
  },

  deleteBudget: (budgetId) => {
    if (!State._cache?.budgets) return;
    State._cache.budgets = State._cache.budgets.filter(b => b.id !== budgetId);
    State._scheduleSave();
  },

  // ── Utilities ──

  genId: () => 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),

  fmt: (n) => {
    const num = Number(n) || 0;
    return 'R ' + num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  newPlan: _makePlan,

  resolveItemAmt: (item, plan) => {
    if (!item.pctMode) return parseFloat(item.amount) || 0;
    const pct = parseFloat(item.pctValue) || 0;
    if (pct === 0) return 0;
    const allCats = [...plan.income.categories, ...plan.expenses.categories];
    let base = 0;
    if (item.refType === 'afterTax') {
      const gross = plan.income.categories
        .filter(c => !c.disabled)
        .reduce((s, c) => s + c.items
          .filter(i => !i.disabled && !i.pctMode)
          .reduce((ss, i) => ss + (parseFloat(i.amount) || 0), 0), 0);
      base = gross - calcSATax(gross);
    } else if (item.refType === 'cat') {
      const cat = allCats.find(c => c.id === item.refId);
      if (cat) {
        base = cat.items
          .filter(i => !i.disabled && !i.pctMode)
          .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
      }
    } else if (item.refType === 'item') {
      for (const cat of allCats) {
        const ri = cat.items.find(i => i.id === item.refId && !i.pctMode);
        if (ri) { base = parseFloat(ri.amount) || 0; break; }
      }
    }
    return Math.round((pct / 100) * base * 100) / 100;
  }
};

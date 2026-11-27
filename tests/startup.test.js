const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const signedInSession = { user: { id: 'user-1', email: 'private@example.test' } };
const emptyResult = { data: [], error: null };
const summaryResult = {
  data: {
    transaction_count: 0, income_count: 0, expense_count: 0,
    total_income: 0, total_expense: 0, month_income: 0, month_expense: 0, month_net_cash_flow: 0,
    assets_value: 0, cash_value: 0, debts_value: 0, liabilities_value: 0,
    net_worth: 0, income_expense_ratio: null, savings_rate: null,
    monthly_debt_repayments: 0, monthly_borrowing: 0, monthly_asset_purchases: 0,
    assets_by_type: [], liabilities_by_type: [], month_categories: [],
  },
  error: null,
};
const comparisonResult = {
  data: {
    income_variance: 0, expense_variance: 0, net_variance: 0,
    income_change_pct: null, expense_change_pct: null,
    income_change_text: '', expense_change_text: '',
    savings_rate: null, expense_ratio: null,
  },
  error: null,
};

function never() {
  return new Promise(() => {});
}

function createHarness({
  sessions = [], spaceResults = [], rpcResults = {},
  summary = summaryResult, comparison = comparisonResult,
} = {}) {
  const elements = new Map();
  const listeners = new Map();
  const timers = new Map();
  const warnings = [];
  const sessionValues = new Map();
  const rpcCalls = [];
  const tableCalls = [];
  let nextTimerId = 0;
  let authListener = null;
  let spaceQueryCount = 0;
  let rpcCallCount = 0;

  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        selector, hidden: false, disabled: false, textContent: '', innerHTML: '',
        value: '', checked: false, options: [], dataset: {}, style: {},
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener(type, handler) { listeners.set(`${selector}:${type}`, handler); },
      });
    }
    return elements.get(selector);
  };
  const next = (queue, fallback, ...args) => {
    if (!queue.length) return fallback;
    const item = queue.shift();
    return typeof item === 'function' ? item(...args) : item;
  };

  const client = {
    auth: {
      onAuthStateChange(callback) { authListener = callback; },
      getSession() {
        return next(sessions, Promise.resolve({ data: { session: null }, error: null }));
      },
    },
    from(table) {
      tableCalls.push(table);
      if (table === 'spaces') spaceQueryCount += 1;
      const builder = {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        then(resolve, reject) {
          let result = emptyResult;
          if (table === 'spaces') {
            result = next(spaceResults, {
              data: [{ id: 'space-1', name: 'Cá nhân', kind: 'personal', owner_id: 'user-1' }],
              error: null,
            });
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name, args) {
      rpcCallCount += 1;
      rpcCalls.push({ name, args });
      const queue = rpcResults[name] || [];
      const fallback = name === 'get_space_financial_summary_v2' ? summary
        : name === 'get_space_financial_summary_comparison' ? comparison : emptyResult;
      return next(queue, fallback, args);
    },
  };

  const document = {
    querySelector: element,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: (selector) => element(selector),
  };
  const window = {
    SUPABASE_CONFIG: { url: 'https://test-project.supabase.co', anonKey: 'test-public-anon-key' },
    supabase: { createClient: () => client },
    location: { hash: '', pathname: '/', origin: 'https://test.example', href: 'https://test.example/' },
    history: { replaceState() {} },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    scrollTo() {},
  };
  const storage = {
    getItem: (key) => sessionValues.get(key) || null,
    setItem: (key, value) => sessionValues.set(key, String(value)),
    removeItem: (key) => sessionValues.delete(key),
  };
  const context = {
    window, document, sessionStorage: storage, localStorage: storage,
    URL, URLSearchParams, console: { warn: (...args) => warnings.push(args) },
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true, alert() {},
  };

  vm.runInNewContext(appSource, context, { filename: 'app.js' });

  return {
    elements,
    warnings,
    get spaceQueryCount() { return spaceQueryCount; },
    get rpcCallCount() { return rpcCallCount; },
    rpcCalls,
    tableCalls,
    click(selector) {
      const handler = listeners.get(`${selector}:click`);
      assert.ok(handler, `no click handler registered for ${selector}`);
      handler({ preventDefault() {} });
    },
    change(selector, value) {
      const handler = listeners.get(`${selector}:change`);
      assert.ok(handler, `no change handler registered for ${selector}`);
      handler({ target: { value }, preventDefault() {} });
    },
    emitAuth(event, session) {
      assert.ok(authListener, 'auth listener was not registered');
      authListener(event, session);
    },
    expireTimers() {
      for (const [id, timer] of [...timers]) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

async function flushPromises() {
  for (let index = 0; index < 30; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('the auth gate includes a visible retry action for startup errors', () => {
  assert.match(indexHtml, /id="authGateRetry"/);
  assert.match(appSource, /#authGateRetry'\)\.addEventListener\('click'/);
});

test('a hung auth session check exits the spinner and retry recovers', async () => {
  const app = createHarness({
    sessions: [never(), Promise.resolve({ data: { session: null }, error: null })],
  });
  assert.equal(app.elements.get('#authGateTitle').textContent, 'Đang kiểm tra phiên đăng nhập…');

  app.expireTimers();
  await flushPromises();
  assert.equal(app.elements.get('#authGateTitle').textContent, 'Không thể mở dữ liệu tài chính');
  assert.equal(app.elements.get('#authGateRetry').hidden, false);
  assert.match(app.elements.get('#authGateMessage').textContent, /thử lại/i);

  app.click('#authGateRetry');
  await flushPromises();
  assert.equal(app.elements.get('#authGateTitle').textContent, 'Đăng nhập để mở tài chính');
  assert.equal(app.elements.get('#authGateRetry').hidden, true);
});

test('a rejected auth session check shows safe diagnostics and retry', async () => {
  const app = createHarness({
    sessions: [Promise.resolve({
      data: { session: null },
      error: { name: 'AuthApiError', code: 'invalid_grant', message: 'secret-token private@example.test' },
    })],
  });
  await flushPromises();

  const message = app.elements.get('#authGateMessage').textContent;
  assert.match(message, /phiên đăng nhập/i);
  assert.match(message, /invalid_grant/);
  assert.doesNotMatch(message, /secret-token|private@example\.test/);
  assert.equal(app.elements.get('#authGateRetry').hidden, false);
  assert.doesNotMatch(JSON.stringify(app.warnings), /secret-token|private@example\.test/);
});

test('a hung spaces query exits loading and retry completes startup', async () => {
  const app = createHarness({
    sessions: [
      Promise.resolve({ data: { session: signedInSession }, error: null }),
      Promise.resolve({ data: { session: signedInSession }, error: null }),
    ],
    spaceResults: [
      never(),
      () => new Promise((resolve) => setImmediate(() => resolve({
        data: [{ id: 'space-1', name: 'Cá nhân', kind: 'personal', owner_id: 'user-1' }],
        error: null,
      }))),
    ],
  });
  await flushPromises();
  assert.equal(app.spaceQueryCount, 1);

  app.expireTimers();
  await flushPromises();
  assert.equal(app.elements.get('#authGateTitle').textContent, 'Không thể mở dữ liệu tài chính');
  assert.match(app.elements.get('#authGateMessage').textContent, /không gian/i);
  assert.equal(app.elements.get('#authGateRetry').hidden, false);

  app.click('#authGateRetry');
  await flushPromises();
  assert.equal(
    app.elements.get('#appContent').hidden,
    false,
    `${app.elements.get('#authGateTitle').textContent}: ${app.elements.get('#authGateMessage').textContent}; spaces=${app.spaceQueryCount}; rpc=${app.rpcCallCount}`,
  );
  assert.equal(app.elements.get('#authGateRetry').hidden, true);
});

test('a hung financial data RPC times out and can be retried', async () => {
  const app = createHarness({
    sessions: [
      Promise.resolve({ data: { session: signedInSession }, error: null }),
      Promise.resolve({ data: { session: signedInSession }, error: null }),
    ],
    rpcResults: {
      list_space_transactions: [never(), emptyResult],
    },
  });
  await flushPromises();
  assert.ok(app.rpcCallCount > 0);

  app.expireTimers();
  await flushPromises();
  assert.equal(app.elements.get('#authGateRetry').hidden, false);
  assert.match(app.elements.get('#authGateMessage').textContent, /dữ liệu tài chính/i);

  app.click('#authGateRetry');
  await flushPromises();
  assert.equal(
    app.elements.get('#appContent').hidden,
    false,
    `${app.elements.get('#authGateTitle').textContent}: ${app.elements.get('#authGateMessage').textContent}; spaces=${app.spaceQueryCount}; rpc=${app.rpcCallCount}`,
  );
});

test('switching spaces cannot leave the auth gate loading forever', async () => {
  const personal = { id: 'space-1', name: 'Cá nhân', kind: 'personal', owner_id: 'user-1' };
  const family = { id: 'space-2', name: 'Gia đình', kind: 'family', owner_id: 'user-1' };
  const app = createHarness({
    sessions: [
      Promise.resolve({ data: { session: signedInSession }, error: null }),
      Promise.resolve({ data: { session: signedInSession }, error: null }),
    ],
    spaceResults: [
      { data: [personal, family], error: null },
      { data: [personal, family], error: null },
    ],
    rpcResults: {
      list_space_transactions: [emptyResult, emptyResult, emptyResult, never(), emptyResult],
    },
  });
  await flushPromises();
  app.change('#activeSpaceSelect', 'space-2');
  await flushPromises();
  app.expireTimers();
  await flushPromises();

  assert.equal(app.elements.get('#authGateRetry').hidden, false);
  app.click('#authGateRetry');
  await flushPromises();
  assert.equal(app.elements.get('#appContent').hidden, false);
});

test('a rejected financial RPC does not expose its error text and can be retried', async () => {
  const app = createHarness({
    sessions: [
      Promise.resolve({ data: { session: signedInSession }, error: null }),
      Promise.resolve({ data: { session: signedInSession }, error: null }),
    ],
    rpcResults: {
      list_space_transactions: [
        Promise.resolve({ data: null, error: { code: '42501', message: 'private@example.test secret-token' } }),
        emptyResult,
      ],
    },
  });
  await flushPromises();
  assert.equal(app.elements.get('#authGateRetry').hidden, false);
  assert.match(app.elements.get('#authGateMessage').textContent, /dữ liệu tài chính/i);
  assert.doesNotMatch(app.elements.get('#authGateMessage').textContent, /private@example\.test|secret-token/);

  app.click('#authGateRetry');
  await flushPromises();
  assert.equal(
    app.elements.get('#appContent').hidden,
    false,
    `${app.elements.get('#authGateTitle').textContent}: ${app.elements.get('#authGateMessage').textContent}; spaces=${app.spaceQueryCount}; rpc=${app.rpcCallCount}`,
  );
});

test('PGRST202 identifies the missing startup RPC and required migration without leaking the server error', async () => {
  const app = createHarness({
    sessions: [
      Promise.resolve({ data: { session: signedInSession }, error: null }),
      Promise.resolve({ data: { session: signedInSession }, error: null }),
    ],
    rpcResults: {
      get_space_financial_summary_v2: [
        Promise.resolve({
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find function with secret private@example.test',
            details: 'Sensitive server detail',
          },
        }),
        summaryResult,
      ],
    },
  });
  await flushPromises();

  const message = app.elements.get('#authGateMessage').textContent;
  assert.match(message, /get_space_financial_summary_v2/);
  assert.match(message, /20261127120000/);
  assert.match(message, /schema cache/i);
  assert.doesNotMatch(message, /private@example\.test|Sensitive server detail|secret/);
  assert.match(JSON.stringify(app.warnings), /get_space_financial_summary_v2/);
  assert.doesNotMatch(JSON.stringify(app.warnings), /private@example\.test|Sensitive server detail|secret/);

  app.click('#authGateRetry');
  await flushPromises();
  assert.equal(app.elements.get('#appContent').hidden, false);
});

test('startup error identifies the RPC and migration for PostgreSQL 42883', async () => {
  const app = createHarness({
    sessions: [Promise.resolve({ data: { session: signedInSession }, error: null })],
    rpcResults: {
      get_space_financial_summary_comparison: [
        Promise.resolve({
          data: null,
          error: {
            code: '42883',
            message: 'function format_change_text(numeric,numeric) does not exist',
            details: 'Sensitive SQL detail',
          },
        }),
      ],
    },
  });
  await flushPromises();

  const message = app.elements.get('#authGateMessage').textContent;
  assert.match(message, /get_space_financial_summary_comparison/);
  assert.match(message, /42883/);
  assert.match(message, /20261127140000/);
  assert.doesNotMatch(message, /Sensitive SQL detail|function format_change_text/);
  assert.match(JSON.stringify(app.warnings), /get_space_financial_summary_comparison/);
  assert.doesNotMatch(JSON.stringify(app.warnings), /Sensitive SQL detail|function format_change_text/);
});

test('empty and nullable summary fields render safe zeroes or unavailable ratios without NaN', async () => {
  const app = createHarness({
    sessions: [Promise.resolve({ data: { session: signedInSession }, error: null })],
    rpcResults: {
      get_space_financial_summary_v2: [Promise.resolve({
        data: {
          transaction_count: '0',
          income_count: '0',
          expense_count: '0',
          total_income: '0',
          total_expense: '0',
          month_income: '0',
          month_expense: '0',
          assets_value: '0',
          cash_value: '0',
          debts_value: '0',
          income_expense_ratio: null,
          savings_rate: null,
        },
        error: null,
      })],
    },
    comparison: { data: {}, error: null },
  });
  await flushPromises();

  assert.equal(app.elements.get('#appContent').hidden, false);
  assert.equal(app.elements.get('#savingsRate').textContent, 'Chưa đủ dữ liệu');
  assert.match(app.elements.get('#reportMetrics').innerHTML, /Chưa đủ dữ liệu/);
  assert.doesNotMatch(
    [...app.elements.values()].map(({ textContent, innerHTML }) => `${textContent} ${innerHTML}`).join(' '),
    /NaN/,
  );
});

test('bigint strings across transactions, accounts, and movements render as numbers', async () => {
  const numericSummary = Object.fromEntries(
    Object.entries(summaryResult.data).map(([field, value]) => [
      field,
      typeof value === 'number' ? String(value) : value,
    ]),
  );
  const app = createHarness({
    sessions: [Promise.resolve({ data: { session: signedInSession }, error: null })],
    rpcResults: {
      list_space_transactions: [
        { data: [{ id: 'tx-1', type: 'expense', amount: '12000', category: 'Food', date: '2026-11-27T00:00:00Z' }], error: null },
        emptyResult,
      ],
      list_space_assets: [{
        data: [{
          id: 'asset-1', name: 'Cash', kind: 'cash', value: '250000',
          account_type_id: 'type-cash', account_type_label: 'Cash', is_liquid: true,
        }],
        error: null,
      }],
      list_space_liabilities: [{
        data: [{
          id: 'debt-1', name: 'Card', kind: 'card', amount: '0',
          account_type_id: 'type-card', account_type_label: 'Card',
        }],
        error: null,
      }],
      list_space_liquid_assets: [{
        data: [{
          id: 'asset-1', name: 'Cash', value: '250000',
          account_type_label: 'Cash', created_at: '2026-11-27T00:00:00Z',
        }],
        error: null,
      }],
      list_space_balance_movements: [{
        data: [{
          id: 'movement-1', account_name: 'Cash', movement_type: 'adjustment',
          amount: '-500', occurred_at: '2026-11-27T00:00:00Z', note: '',
        }],
        error: null,
      }],
    },
    summary: { data: numericSummary, error: null },
  });
  await flushPromises();

  assert.equal(app.elements.get('#appContent').hidden, false);
  assert.match(app.elements.get('#assetList').innerHTML, /250\.000 ₫/);
  assert.match(app.elements.get('#movementList').innerHTML, /500 ₫/);
  assert.doesNotMatch(
    [...app.elements.values()].map(({ textContent, innerHTML }) => `${textContent} ${innerHTML}`).join(' '),
    /NaN/,
  );
});

test('malformed financial summary values fail visibly without rendering NaN or echoing data', async () => {
  const app = createHarness({
    sessions: [Promise.resolve({ data: { session: signedInSession }, error: null })],
    rpcResults: {
      get_space_financial_summary_v2: [Promise.resolve({
        data: {
          ...summaryResult.data,
          total_income: 'not-a-number private@example.test',
        },
        error: null,
      })],
    },
  });
  await flushPromises();

  const message = app.elements.get('#authGateMessage').textContent;
  assert.match(message, /total_income/);
  assert.doesNotMatch(message, /not-a-number|private@example\.test|NaN/);
  assert.equal(app.elements.get('#authGateRetry').hidden, false);
});

test('an auth event supersedes a delayed stale getSession result', async () => {
  let resolveSession;
  const delayedSession = new Promise((resolve) => { resolveSession = resolve; });
  const app = createHarness({ sessions: [delayedSession] });

  app.emitAuth('SIGNED_OUT', null);
  resolveSession({ data: { session: signedInSession }, error: null });
  await flushPromises();

  assert.equal(app.elements.get('#authGateTitle').textContent, 'Đăng nhập để mở tài chính');
  assert.equal(app.spaceQueryCount, 0);
});

test('startup reads bounded pages from a 100,000-transaction mock instead of loading the table', async () => {
  const recordCount = 100000;
  const records = Array.from({ length: recordCount }, (_, index) => ({
    id: `tx-${String(recordCount - index).padStart(6, '0')}`,
    type: 'expense',
    amount: 125,
    category: 'Food',
    note: '',
    date: '2026-06-15T12:00:00.000Z',
  }));
  let returnedRows = 0;
  const pageFromMock = (args) => {
    const page = records.slice(0, args.p_limit);
    returnedRows += page.length;
    return { data: page, error: null };
  };
  const app = createHarness({
    sessions: [Promise.resolve({ data: { session: signedInSession }, error: null })],
    rpcResults: {
      list_space_transactions: [pageFromMock, pageFromMock],
    },
  });

  await flushPromises();

  const transactionCalls = app.rpcCalls.filter(({ name }) => name === 'list_space_transactions');
  assert.deepEqual(transactionCalls.map(({ args }) => args.p_limit), [51, 5]);
  assert.equal(returnedRows, 56);
  assert.ok(returnedRows < recordCount);
  assert.equal(app.tableCalls.includes('transactions'), false);
  assert.equal(app.elements.get('#appContent').hidden, false);
});

(() => {
  const STORAGE_KEY = 'dong-tien-finance-v1';
  const emptySummary = () => ({
    transaction_count: 0, income_count: 0, expense_count: 0,
    total_income: 0, total_expense: 0, month_income: 0, month_expense: 0,
    assets_value: 0, cash_value: 0, debts_value: 0, month_categories: [],
  });
  const emptyData = () => ({
    transactions: [], recentTransactions: [], assets: [], debts: [], categories: [],
    summary: emptySummary(), hasMoreTransactions: false, transactionCursor: null,
  });
  let data = emptyData();
  let filter = 'all';
  let formMode = 'transaction';
  let transactionType = 'expense';
  let activeUser = null;
  let activeSpace = null;
  let spaces = [];
  let authLoading = true;
  let loadingUserId = null;
  let authGeneration = 0;
  let supabaseClient = null;
  let authGateError = '';
  let pendingInviteToken = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  if (pendingInviteToken) sessionStorage.setItem('dong-tien-pending-invite', pendingInviteToken);
  else pendingInviteToken = sessionStorage.getItem('dong-tien-pending-invite');

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const hasLegacyLocalData = () => {
    try { return Boolean(localStorage.getItem(STORAGE_KEY)); }
    catch { return false; }
  };
  const formatMoney = (value) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(value) + ' ₫';
  const compactMoney = (value) => Math.abs(value) >= 1_000_000
    ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(value / 1_000_000) + ' tr'
    : formatMoney(value);
  const makeId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
  const hasCloudSession = () => Boolean(supabaseClient && activeUser && activeSpace);

  function isServiceRoleKey(key) {
    if (key.startsWith('sb_secret_')) return true;
    const payload = key.split('.')[1];
    if (!payload) return false;
    try {
      const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      return claims.role === 'service_role';
    } catch {
      return false;
    }
  }

  function validateData(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.transactions) || !Array.isArray(value.assets) || !Array.isArray(value.debts)) throw new Error('Dữ liệu sao lưu không đúng định dạng.');
    value.transactions.forEach((item) => {
      if (!item.id || !['income','expense'].includes(item.type) || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0 || !item.category || !Number.isFinite(Date.parse(item.date))) throw new Error('Giao dịch trong tệp sao lưu không hợp lệ.');
      const linkedAssetId = item.linkedAssetId || item.linked_asset_id;
      const linkedDebtId = item.linkedDebtId || item.linked_debt_id;
      const balanceEffect = item.balanceEffect || item.balance_effect;
      if ((linkedAssetId && linkedDebtId) || ((linkedAssetId || linkedDebtId) && !['increase', 'decrease'].includes(balanceEffect))) {
        throw new Error('Liên kết số dư trong tệp sao lưu không hợp lệ.');
      }
    });
    value.assets.forEach((item) => {
      if (!item.id || typeof item.name !== 'string' || typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0) throw new Error('Tài sản trong tệp sao lưu không hợp lệ.');
    });
    value.debts.forEach((item) => {
      if (!item.id || typeof item.name !== 'string' || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0) throw new Error('Khoản nợ trong tệp sao lưu không hợp lệ.');
    });
  }

  function totals() {
    const summary = data.summary;
    return {
      assetsValue: summary.assets_value,
      cashValue: summary.cash_value,
      debtsValue: summary.debts_value,
      available: summary.cash_value,
      netWorth: summary.assets_value - summary.debts_value,
    };
  }

  function transactionRow(item, deletable = true) {
    const positive = item.type === 'income';
    const date = new Date(item.date).toLocaleDateString('vi-VN', { day: 'numeric', month: 'short' });
    const linkedAsset = item.linkedAssetId && data.assets.find((asset) => asset.id === item.linkedAssetId);
    const linkedDebt = item.linkedDebtId && data.debts.find((debt) => debt.id === item.linkedDebtId);
    const linkedName = linkedAsset?.name || linkedDebt?.name;
    return `<div class="transaction-row ${positive ? 'income' : ''}">
      <span class="icon">${positive ? '↗' : '◈'}</span><span class="transaction-main"><b>${escapeHtml(item.note || item.category)}</b><small>${escapeHtml(item.category)} · ${escapeHtml(date)}${linkedName ? ' · ↔ ' + escapeHtml(linkedName) : ''}</small></span>
      <span class="transaction-amount ${positive ? 'income' : ''}">${positive ? '+' : '−'}${formatMoney(item.amount)}</span>
      ${deletable ? `<span class="row-actions"><button type="button" data-edit-kind="transaction" data-edit-id="${escapeHtml(item.id)}" aria-label="Sửa giao dịch">Sửa</button><button type="button" data-delete-transaction="${escapeHtml(item.id)}" aria-label="Xóa giao dịch">×</button></span>` : ''}</div>`;
  }

  function empty(title, detail) {
    return `<div class="empty"><span>⌂</span><b>${escapeHtml(title)}</b><p>${escapeHtml(detail)}</p></div>`;
  }

  function renderOverview() {
    const t = totals();
    const now = new Date();
    $('#netWorth').textContent = formatMoney(t.netWorth);
    $('#availableValue').textContent = formatMoney(t.available);
    $('#debtValue').textContent = formatMoney(t.debtsValue);
    $('#monthLabel').textContent = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric' }).format(now);
    $('#todayLabel').textContent = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    $('#monthIncome').textContent = compactMoney(data.summary.month_income);
    $('#monthExpense').textContent = compactMoney(data.summary.month_expense);
    $('#recentTransactions').innerHTML = data.recentTransactions.length ? data.recentTransactions.slice(0, 4).map((item) => transactionRow(item, false)).join('') : empty('Bắt đầu ghi dòng tiền', 'Giao dịch đầu tiên sẽ xuất hiện ở đây. Dữ liệu được lưu riêng cho bạn.');
  }

  function renderTransactions() {
    const count = filter === 'income' ? data.summary.income_count
      : filter === 'expense' ? data.summary.expense_count : data.summary.transaction_count;
    const sum = filter === 'income' ? data.summary.total_income
      : filter === 'expense' ? -data.summary.total_expense
        : data.summary.total_income - data.summary.total_expense;
    $('#filteredCount').textContent = String(count);
    $('#filteredSum').textContent = (sum >= 0 ? '+' : '−') + formatMoney(Math.abs(sum));
    $('#filteredSum').style.color = sum >= 0 ? 'var(--primary)' : 'var(--danger)';
    $('#transactionList').innerHTML = data.transactions.length
      ? data.transactions.map(transactionRow).join('')
      : empty(filter === 'all' ? 'Chưa có giao dịch' : `Chưa có ${filter === 'income' ? 'thu nhập' : 'chi tiêu'}`, 'Thêm khoản đầu tiên để bắt đầu theo dõi dòng tiền.');
    $('#loadMoreTransactions').hidden = !data.hasMoreTransactions;
    $('#deleteHint').hidden = count === 0;
  }

  function renderAssets() {
    const t = totals();
    $('#assetNetValue').textContent = formatMoney(t.assetsValue - t.debtsValue);
    $('#assetTotal').textContent = compactMoney(t.assetsValue);
    $('#debtTotal').textContent = compactMoney(t.debtsValue);
    const kindNames = { cash:'Tiền mặt & tiền gửi', investment:'Đầu tư', property:'Bất động sản', business:'Kinh doanh', other:'Tài sản khác' };
    $('#assetList').innerHTML = data.assets.length ? data.assets.map((asset) => `<div class="item-row"><span class="item-icon">▤</span><span class="item-main"><b>${escapeHtml(asset.name)}</b><small>${escapeHtml(kindNames[asset.kind] || 'Tài sản khác')}</small></span><span class="item-amount">${formatMoney(asset.value)}</span><span class="row-actions"><button type="button" data-edit-kind="asset" data-edit-id="${escapeHtml(asset.id)}">Sửa</button><button type="button" data-delete-asset="${escapeHtml(asset.id)}" aria-label="Xóa tài sản">×</button></span></div>`).join('') : empty('Chưa có tài sản', 'Thêm tiền mặt, khoản tiết kiệm, khoản đầu tư hoặc tài sản khác.');
    $('#debtList').innerHTML = data.debts.length ? data.debts.map((debt) => `<div class="item-row debt"><span class="item-icon">▤</span><span class="item-main"><b>${escapeHtml(debt.name)}</b><small>${escapeHtml(debt.kind)}${debt.dueDate ? ' · Hạn ' + escapeHtml(debt.dueDate) : ''}</small></span><span class="item-amount">${formatMoney(debt.amount)}</span><span class="row-actions"><button type="button" data-edit-kind="debt" data-edit-id="${escapeHtml(debt.id)}">Sửa</button><button type="button" data-delete-debt="${escapeHtml(debt.id)}" aria-label="Xóa khoản nợ">×</button></span></div>`).join('') : empty('Chưa có khoản nợ', 'Theo dõi dư nợ thẻ tín dụng, vay hoặc trả góp tại đây.');
  }

  function renderAnalysis() {
    const now = new Date();
    const income = data.summary.month_income;
    const expense = data.summary.month_expense;
    const categories = data.summary.month_categories.map((item) => [item.category, Number(item.amount)]);
    const month = new Intl.DateTimeFormat('vi-VN', { month:'long', year:'numeric' }).format(now);
    const largest = categories[0]?.[0] || '—';
    $('#analysisMonth').textContent = month;
    $('#analysisIncome').textContent = formatMoney(income);
    $('#analysisExpense').textContent = formatMoney(expense);
    $('#analysisNet').textContent = (income-expense >= 0 ? '+' : '−') + formatMoney(Math.abs(income-expense));
    $('#analysisNet').style.color = income-expense >= 0 ? 'var(--primary)' : 'var(--danger)';
    const max = Math.max(income, expense);
    $('#incomeBar').style.width = max ? Math.max(income/max*100, income ? 4 : 0) + '%' : '0';
    $('#expenseBar').style.width = max ? Math.max(expense/max*100, expense ? 4 : 0) + '%' : '0';
    $('#analysisInsight').textContent = !income && !expense ? 'Khi bạn ghi nhận thu chi, các xu hướng trong tháng sẽ được tổng hợp tại đây.' : expense === 0 ? 'Tháng này chưa có khoản chi tiêu nào được ghi nhận.' : income === 0 ? `Khoản chi nhiều nhất hiện tại là ${largest}. Hãy thêm thu nhập để xem đầy đủ dòng tiền.` : income >= expense ? `Thu nhập tháng này cao hơn chi tiêu ${formatMoney(income-expense)}. Bạn đang giữ được dòng tiền dương.` : `Chi tiêu đang cao hơn thu nhập ${formatMoney(expense-income)}. Hãy xem lại nhóm ${largest}.`;
    const totalExpense = categories.reduce((sum, [,amount]) => sum + amount, 0);
    $('#categoryList').innerHTML = categories.length ? categories.map(([name,amount], index) => { const share = totalExpense ? amount/totalExpense : 0; return `<article class="category-row"><div class="category-head"><b>${escapeHtml(name)}</b><b>${formatMoney(amount)}</b></div><div class="category-bottom"><div class="track"><i style="width:${Math.max(share*100,3)}%;background:${index===0?'var(--primary)':'var(--gold)'}"></i></div><small>${Math.round(share*100)}%</small></div></article>`; }).join('') : empty('Chưa đủ dữ liệu phân tích', 'Thêm các khoản thu chi để xem tỷ trọng chi tiêu theo danh mục.');
  }

  function renderCategoryManager() {
    $('#categoryManager').innerHTML = data.categories.map((category) => `<div class="member-row">
      <span>${escapeHtml(category.label)}</span><small>${category.type === 'income' ? 'Thu nhập' : 'Chi tiêu'}${category.is_archived ? ' · Đã lưu trữ' : ''}</small>
      ${category.is_archived ? '' : `<button type="button" data-archive-category="${escapeHtml(category.id)}">Lưu trữ</button>`}
    </div>`).join('') || '<p class="hint">Chưa có danh mục.</p>';
  }

  function renderAll() { renderOverview(); renderTransactions(); renderAssets(); renderAnalysis(); renderCategoryManager(); }

  function setCloudStatus(message, isError = false) {
    const notice = $('#cloudStatus');
    notice.textContent = message;
    notice.classList.toggle('error', isError);
    notice.hidden = !message;
  }

  function renderConnection() {
    const configured = Boolean(supabaseClient);
    const configPresent = Boolean(window.SUPABASE_CONFIG?.url && window.SUPABASE_CONFIG?.anonKey);
    const signedIn = Boolean(activeUser);
    $('#authForm').hidden = !configured || signedIn;
    $('#signedInControls').hidden = !activeUser;
    $('#googleSignIn').hidden = !configured || signedIn;
    $('#uploadLocalData').hidden = !activeUser || !activeSpace || activeSpace.kind !== 'personal' || !hasLegacyLocalData();
    $('#importBackup').hidden = !activeSpace || activeSpace.kind !== 'personal';
    $('#clearData').hidden = !activeSpace || activeSpace.kind !== 'personal';
    $('#familyControls').hidden = !activeUser;
    $('#cloudSetupHint').hidden = configured;
    $('#connectionSummary').textContent = activeUser ? `Đã kết nối · ${activeSpace?.name || 'đang tải không gian'}` : configured ? 'Đăng nhập để mở dữ liệu tài chính riêng tư' : 'Cần cấu hình Supabase để sử dụng';
    $('#sidebarAccountStatus').textContent = activeUser ? activeUser.email : configured ? 'Cần đăng nhập' : 'Chưa cấu hình';
    $('#privacyNoteText').textContent = activeSpace?.kind === 'family' ? `Đang xem không gian chia sẻ: ${activeSpace.name}.` : 'Dữ liệu cá nhân chỉ hiển thị với bạn.';
    if (activeUser) $('#signedInEmail').textContent = activeUser.email;
    $('#authGate').hidden = Boolean(activeUser && activeSpace && !authLoading);
    $('#appContent').hidden = !activeUser || !activeSpace || authLoading;
    $('#appBottomNav').hidden = !activeUser || !activeSpace || authLoading;
    $('#authGateSettings').hidden = !configPresent || authLoading;
    $('#authGateSettings').textContent = signedIn ? 'Mở cài đặt tài khoản' : 'Đăng nhập hoặc tạo tài khoản';
    if (authGateError) {
      $('#authGateTitle').textContent = 'Không thể mở dữ liệu tài chính';
      $('#authGateMessage').textContent = authGateError;
    } else if (!configured) {
      $('#authGateTitle').textContent = 'Cần kết nối Supabase';
      $('#authGateMessage').textContent = 'Thiết lập URL và public key của Supabase để đăng nhập. Dữ liệu tài chính không được mở ở chế độ chưa xác thực.';
    } else if (authLoading) {
      $('#authGateTitle').textContent = 'Đang kiểm tra phiên đăng nhập…';
      $('#authGateMessage').textContent = 'Dữ liệu tài chính chỉ hiển thị sau khi phiên đăng nhập được xác nhận.';
    } else if (!signedIn) {
      $('#authGateTitle').textContent = 'Đăng nhập để mở tài chính';
      $('#authGateMessage').textContent = 'Tạo tài khoản bằng email và mật khẩu hoặc tiếp tục với Google. Dữ liệu cá nhân của bạn không được chia sẻ.';
    } else {
      $('#authGateTitle').textContent = 'Đang tải không gian tài chính…';
      $('#authGateMessage').textContent = 'Đang tải dữ liệu được phép truy cập cho tài khoản này.';
    }
  }

  function initializeSupabase() {
    const config = window.SUPABASE_CONFIG;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string' || !config.url || !config.anonKey) {
      authLoading = false;
      renderConnection();
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      authLoading = false;
      authGateError = 'Không tải được thư viện Supabase. Kiểm tra kết nối mạng hoặc chặn nội dung CDN.';
      $('#cloudSetupHint').textContent = 'Không tải được thư viện Supabase. Kiểm tra kết nối mạng hoặc chặn nội dung CDN; đăng nhập và dữ liệu tài chính đang tạm thời không khả dụng.';
      renderConnection();
      return;
    }
    try {
      const endpoint = new URL(config.url);
      if (endpoint.protocol !== 'https:' || /your-|placeholder|example/i.test(config.url + config.anonKey)) throw new Error('Cấu hình Supabase chưa hợp lệ. Hãy thay URL và anon key mẫu trong supabase-config.js.');
      if (isServiceRoleKey(config.anonKey)) throw new Error('Không dùng service-role/secret key trong website. Hãy dùng anon/public (publishable) key.');
      supabaseClient = window.supabase.createClient(config.url, config.anonKey);
      supabaseClient.auth.onAuthStateChange((_event, session) => {
        void handleSession(session);
      });
      void supabaseClient.auth.getSession().then(({ data, error }) => {
        if (error) throw error;
        return handleSession(data.session);
      }).catch((error) => {
        authLoading = false;
        authGateError = error.message;
        renderConnection();
        setCloudStatus(`Không thể kiểm tra phiên đăng nhập: ${error.message}`, true);
      });
    } catch (error) {
      authLoading = false;
      authGateError = error.message;
      $('#cloudSetupHint').textContent = error.message || 'Không thể khởi tạo kết nối Supabase. Kiểm tra tệp cấu hình.';
      renderConnection();
    }
  }

  async function handleSession(session) {
    const previousUserId = activeUser?.id || null;
    activeUser = session?.user || null;
    if (!activeUser) {
      authGeneration += 1;
      loadingUserId = null;
      authGateError = '';
      authLoading = false;
      activeSpace = null;
      spaces = [];
      data = emptyData();
      renderConnection();
      renderAll();
      return;
    }
    if (previousUserId === activeUser.id && activeSpace) return;
    if (loadingUserId === activeUser.id) return;
    const generation = ++authGeneration;
    loadingUserId = activeUser.id;
    authLoading = true;
    authGateError = '';
    activeSpace = null;
    spaces = [];
    data = emptyData();
    renderConnection();
    renderAll();
    try {
      if (pendingInviteToken) {
        const { error } = await supabaseClient.rpc('accept_space_invite', { p_token: pendingInviteToken });
        if (error) throw error;
        pendingInviteToken = null;
        sessionStorage.removeItem('dong-tien-pending-invite');
        window.history.replaceState(null, '', window.location.pathname);
        setCloudStatus('Đã tham gia không gian gia đình.');
      }
      if (!await loadSpaces(generation)) return;
      const savedSpaceId = sessionStorage.getItem('dong-tien-active-space');
      activeSpace = spaces.find((space) => space.id === savedSpaceId)
        || spaces.find((space) => space.kind === 'personal')
        || spaces[0]
        || null;
      if (!activeSpace) throw new Error('Tài khoản chưa có không gian tài chính. Hãy chạy lại supabase/schema.sql.');
      $('#activeSpaceSelect').value = activeSpace.id;
      sessionStorage.setItem('dong-tien-active-space', activeSpace.id);
      const loadedData = await loadSpaceData(activeSpace.id, filter);
      if (generation !== authGeneration) return;
      data = loadedData;
      setCloudStatus('');
      authLoading = false;
      loadingUserId = null;
      renderConnection();
      renderAll();
      await renderFamilyManagement();
    } catch (error) {
      if (generation !== authGeneration) return;
      authLoading = false;
      loadingUserId = null;
      authGateError = error.message;
      renderConnection();
      setCloudStatus(`Không tải được dữ liệu từ Supabase: ${error.message}`, true);
    }
  }

  async function loadSpaces(generation) {
    const { data: result, error } = await supabaseClient.from('spaces').select('id,name,kind,owner_id').order('created_at');
    if (error) throw error;
    if (generation !== undefined && generation !== authGeneration) return false;
    spaces = result || [];
    $('#activeSpaceSelect').innerHTML = spaces.map((space) =>
      `<option value="${escapeHtml(space.id)}">${escapeHtml(space.kind === 'family' ? 'Gia đình · ' : 'Cá nhân · ')}${escapeHtml(space.name)}</option>`
    ).join('');
    $('#spacePickerWrap').hidden = spaces.length < 2;
    return true;
  }

  function reportPeriod() {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    };
  }

  function normalizeTransaction(item) {
    return {
      ...item,
      amount: Number(item.amount),
      note: item.note || '',
      linkedAssetId: item.linked_asset_id || null,
      linkedDebtId: item.linked_debt_id || null,
      balanceEffect: item.balance_effect || null,
    };
  }

  async function fetchTransactionPage(spaceId, cursor, transactionTypeFilter, limit = 50) {
    const { data: result, error } = await supabaseClient.rpc('list_space_transactions', {
      p_space_id: spaceId,
      p_before_date: cursor?.date || null,
      p_before_id: cursor?.id || null,
      p_limit: limit + 1,
      p_type: transactionTypeFilter === 'all' ? null : transactionTypeFilter,
    });
    if (error) throw error;
    const hasMore = result.length > limit;
    const transactions = result.slice(0, limit).map(normalizeTransaction);
    const last = transactions[transactions.length - 1];
    return {
      transactions,
      hasMore,
      cursor: hasMore && last ? { date: last.date, id: last.id } : null,
    };
  }

  async function fetchAllTransactions(spaceId) {
    const transactions = [];
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const page = await fetchTransactionPage(spaceId, cursor, 'all', 100);
      transactions.push(...page.transactions);
      hasMore = page.hasMore;
      cursor = page.cursor;
    }
    return transactions;
  }

  async function reloadTransactions(transactionTypeFilter = filter) {
    const page = await fetchTransactionPage(activeSpace.id, null, transactionTypeFilter);
    data.transactions = page.transactions;
    data.hasMoreTransactions = page.hasMore;
    data.transactionCursor = page.cursor;
    renderTransactions();
  }

  async function loadSpaceData(spaceId, transactionTypeFilter = 'all') {
    const period = reportPeriod();
    const transactionPageRequest = fetchTransactionPage(spaceId, null, transactionTypeFilter);
    const [transactionPage, recentPage, assets, debts, categories, summary] = await Promise.all([
      transactionPageRequest,
      transactionTypeFilter === 'all' ? transactionPageRequest : fetchTransactionPage(spaceId, null, 'all'),
      supabaseClient.from('assets').select('id,name,kind,value').eq('space_id', spaceId).order('created_at', { ascending: false }),
      supabaseClient.from('debts').select('id,name,kind,amount,due_date').eq('space_id', spaceId).order('created_at', { ascending: false }),
      supabaseClient.from('transaction_categories').select('id,type,label,is_archived').eq('space_id', spaceId).order('type').order('label'),
      supabaseClient.rpc('get_space_financial_summary', {
        p_space_id: spaceId,
        p_month_start: period.start,
        p_month_end: period.end,
      }),
    ]);
    for (const result of [assets, debts, categories, summary]) if (result.error) throw result.error;
    const totals = summary.data;
    return {
      transactions: transactionPage.transactions,
      recentTransactions: recentPage.transactions,
      assets: assets.data.map((item) => ({ ...item, value: Number(item.value) })),
      debts: debts.data.map((item) => ({ id:item.id, name:item.name, kind:item.kind, amount:Number(item.amount), ...(item.due_date ? { dueDate:item.due_date } : {}) })),
      categories: categories.data || [],
      summary: {
        transaction_count: Number(totals.transaction_count),
        income_count: Number(totals.income_count),
        expense_count: Number(totals.expense_count),
        total_income: Number(totals.total_income),
        total_expense: Number(totals.total_expense),
        month_income: Number(totals.month_income),
        month_expense: Number(totals.month_expense),
        assets_value: Number(totals.assets_value),
        cash_value: Number(totals.cash_value),
        debts_value: Number(totals.debts_value),
        month_categories: totals.month_categories || [],
      },
      hasMoreTransactions: transactionPage.hasMore,
      transactionCursor: transactionPage.cursor,
    };
  }

  function transactionPayload(item) {
    return {
      id:item.id, user_id:activeUser.id, space_id:activeSpace.id,
      type:item.type, amount:item.amount, category:item.category, note:item.note || '', date:item.date,
      linked_asset_id:item.linkedAssetId || null, linked_debt_id:item.linkedDebtId || null,
      balance_effect:item.balanceEffect || null,
    };
  }
  function assetPayload(item) {
    return { id:item.id, user_id:activeUser.id, space_id:activeSpace.id, name:item.name, kind:item.kind, value:item.value };
  }
  function debtPayload(item) {
    return { id:item.id, user_id:activeUser.id, space_id:activeSpace.id, name:item.name, kind:item.kind, amount:item.amount, due_date:item.dueDate || null };
  }

  async function replaceCloudData(replacement) {
    if (!activeSpace || activeSpace.kind !== 'personal') throw new Error('Sao lưu, khôi phục và xóa toàn bộ chỉ áp dụng cho không gian cá nhân.');
    const { error } = await supabaseClient.rpc('replace_financial_data', {
      p_space_id: activeSpace.id,
      p_transactions: replacement.transactions.map(transactionPayload),
      p_assets: replacement.assets.map(assetPayload),
      p_debts: replacement.debts.map(debtPayload),
    });
    if (error) throw error;
  }

  async function renderFamilyManagement() {
    $('#familyControls').hidden = !activeUser;
    $('#spaceManagement').hidden = !activeSpace || activeSpace.kind !== 'family';
    $('#familyError').hidden = true;
    $('#inviteError').hidden = true;
    if (!activeSpace || activeSpace.kind !== 'family') return;

    $('#familySpaceTitle').textContent = activeSpace.name;
    $('#deleteFamilySpace').hidden = activeSpace.owner_id !== activeUser.id;
    const [{ data: members, error: membersError }, { data: ownMembership, error: ownError }] = await Promise.all([
      supabaseClient.from('space_members').select('user_id,member_email,role').eq('space_id', activeSpace.id).order('created_at'),
      supabaseClient.from('space_members').select('role').eq('space_id', activeSpace.id).eq('user_id', activeUser.id).single(),
    ]);
    if (membersError) throw membersError;
    if (ownError) throw ownError;
    const canManage = ['owner', 'admin'].includes(ownMembership.role);
    const isOwner = activeSpace.owner_id === activeUser.id;
    $('#inviteActions').hidden = !canManage;
    $('#memberList').innerHTML = members.length ? members.map((member) => {
      const label = member.member_email || member.user_id;
      const roleLabel = member.role === 'owner' ? 'Chủ sở hữu' : member.role === 'admin' ? 'Quản trị viên' : 'Thành viên';
      const roleAction = isOwner && member.role !== 'owner'
        ? `<button type="button" data-member-role="${escapeHtml(member.user_id)}" data-role-next="${member.role === 'admin' ? 'member' : 'admin'}">${member.role === 'admin' ? 'Gỡ quản trị' : 'Đặt quản trị'}</button>`
        : '';
      const removeAction = canManage && member.role === 'member'
        ? `<button type="button" data-remove-member="${escapeHtml(member.user_id)}">Gỡ thành viên</button>`
        : '';
      return `<div class="member-row"><span>${escapeHtml(label)}</span><small>${roleLabel}</small>${roleAction}${removeAction}</div>`;
    }).join('') : empty('Chưa có thành viên', 'Chủ sở hữu sẽ xuất hiện tại đây.');

    $('#invitesHeading').hidden = !canManage;
    $('#inviteList').innerHTML = '';
    if (canManage) {
      const { data: invites, error } = await supabaseClient.from('space_invites')
        .select('id,invited_email,created_at,expires_at,accepted_at,revoked_at')
        .eq('space_id', activeSpace.id).order('created_at', { ascending: false });
      if (error) throw error;
      $('#inviteList').innerHTML = invites.length ? invites.map((invite) => {
        const status = invite.accepted_at ? 'Đã tham gia' : invite.revoked_at ? 'Đã thu hồi' : Date.parse(invite.expires_at) <= Date.now() ? 'Đã hết hạn' : 'Đang chờ';
        const revoke = status === 'Đang chờ' ? `<button type="button" data-revoke-invite="${escapeHtml(invite.id)}">Thu hồi</button>` : '';
        return `<div class="member-row"><span>${escapeHtml(invite.invited_email || 'Liên kết chia sẻ')}</span><small>${status}</small>${revoke}</div>`;
      }).join('') : '<p class="hint">Chưa có lời mời.</p>';
    }
  }

  async function switchSpace(spaceId) {
    const nextSpace = spaces.find((space) => space.id === spaceId);
    if (!nextSpace || nextSpace.id === activeSpace?.id) return;
    const generation = ++authGeneration;
    authLoading = true;
    activeSpace = nextSpace;
    data = emptyData();
    renderConnection();
    renderAll();
    try {
      const loadedData = await loadSpaceData(activeSpace.id, filter);
      if (generation !== authGeneration) return;
      data = loadedData;
      sessionStorage.setItem('dong-tien-active-space', activeSpace.id);
      authLoading = false;
      renderConnection();
      renderAll();
      await renderFamilyManagement();
      setCloudStatus('');
    } catch (error) {
      if (generation !== authGeneration) return;
      authLoading = false;
      renderConnection();
      setCloudStatus(`Không tải được dữ liệu của không gian này: ${error.message}`, true);
    }
  }

  async function refreshSpaces(nextSpaceId) {
    const generation = ++authGeneration;
    authLoading = true;
    activeSpace = null;
    data = emptyData();
    renderConnection();
    renderAll();
    try {
      if (!await loadSpaces(generation)) return;
      activeSpace = spaces.find((space) => space.id === nextSpaceId) || spaces.find((space) => space.kind === 'personal') || spaces[0];
      if (!activeSpace) throw new Error('Không tìm thấy không gian tài chính.');
      $('#activeSpaceSelect').value = activeSpace.id;
      const loadedData = await loadSpaceData(activeSpace.id, filter);
      if (generation !== authGeneration) return;
      data = loadedData;
      sessionStorage.setItem('dong-tien-active-space', activeSpace.id);
      authLoading = false;
      renderConnection();
      renderAll();
      await renderFamilyManagement();
    } catch (error) {
      if (generation !== authGeneration) return;
      authLoading = false;
      renderConnection();
      throw error;
    }
  }

  function navigate(page) {
    $$('.page').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
    $$('[data-nav]').forEach((item) => item.classList.toggle('active', item.dataset.nav === page));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openForm(mode) {
    editingItem = null;
    formMode = mode;
    transactionType = 'expense';
    $('#formTitle').textContent = mode === 'transaction' ? 'Ghi giao dịch' : mode === 'asset' ? 'Thêm tài sản' : 'Thêm khoản nợ';
    $('#transactionTypeGroup').hidden = mode !== 'transaction';
    $('#transactionFields').hidden = mode !== 'transaction';
    $('#assetFields').hidden = mode !== 'asset';
    $('#debtFields').hidden = mode !== 'debt';
    $('#amountInput').value = '';
    $('#nameInput').value = '';
    $('#debtNameInput').value = '';
    $('#noteInput').value = '';
    $('#dueDateInput').value = '';
    $('#linkedBalanceInput').value = '';
    $('#balanceEffectInput').value = 'increase';
    $('#formError').hidden = true;
    $('#financeForm .submit').textContent = 'Lưu khoản mục →';
    updateCategories();
    updateLinkedBalances();
    $('#formModal').hidden = false;
  }

  function editItem(kind, id) {
    const collection = kind === 'transaction' ? data.transactions : kind === 'asset' ? data.assets : data.debts;
    const item = collection.find((entry) => entry.id === id);
    if (!item) return;
    openForm(kind);
    editingItem = item;
    $('#formTitle').textContent = kind === 'transaction' ? 'Sửa giao dịch' : kind === 'asset' ? 'Sửa tài sản' : 'Sửa khoản nợ';
    $('#amountInput').value = String(kind === 'asset' ? item.value : item.amount);
    if (kind === 'transaction') {
      transactionType = item.type;
      $$('[data-type]').forEach((button) => button.classList.toggle('active', button.dataset.type === transactionType));
      updateCategories();
      $('#categoryInput').value = item.category;
      $('#noteInput').value = item.note || '';
      updateLinkedBalances();
      $('#linkedBalanceInput').value = item.linkedAssetId
        ? `asset:${item.linkedAssetId}`
        : item.linkedDebtId ? `debt:${item.linkedDebtId}` : '';
      $('#balanceEffectInput').value = item.balanceEffect || 'increase';
      $('#balanceEffectInput').disabled = !$('#linkedBalanceInput').value;
    } else if (kind === 'asset') {
      $('#nameInput').value = item.name;
      $('#assetKindInput').value = item.kind;
    } else {
      $('#debtNameInput').value = item.name;
      $('#debtKindInput').value = item.kind;
      $('#dueDateInput').value = item.dueDate || '';
    }
    $('#financeForm .submit').textContent = 'Lưu thay đổi →';
  }

  function updateCategories() {
    const categories = data.categories.filter((item) => item.type === transactionType && !item.is_archived);
    const currentCategory = editingItem?.type === transactionType ? editingItem.category : null;
    if (currentCategory && !categories.some((item) => item.label === currentCategory)) {
      categories.push({ label: currentCategory });
    }
    $('#categoryInput').innerHTML = categories.map((item) => `<option value="${escapeHtml(item.label)}">${escapeHtml(item.label)}</option>`).join('');
  }

  function updateLinkedBalances() {
    const options = [
      ...data.assets.map((item) => ({ value: `asset:${item.id}`, label: `Tài sản · ${item.name}` })),
      ...data.debts.map((item) => ({ value: `debt:${item.id}`, label: `Khoản nợ · ${item.name}` })),
    ];
    $('#linkedBalanceInput').innerHTML = '<option value="">Không liên kết</option>' +
      options.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('');
    $('#balanceEffectInput').disabled = !$('#linkedBalanceInput').value;
  }

  function closeForm() { $('#formModal').hidden = true; }

  async function deleteBy(id, kind) {
    if (!confirm('Xóa khoản mục này? Thao tác này không thể hoàn tác.')) return;
    try {
      if (hasCloudSession()) {
        const table = kind === 'transaction' ? 'transactions' : kind === 'asset' ? 'assets' : 'debts';
        const { error } = await supabaseClient.from(table).delete().eq('id', id).eq('space_id', activeSpace.id);
        if (error) throw error;
      }
      data = await loadSpaceData(activeSpace.id, filter);
      renderAll();
    } catch (error) {
      setCloudStatus(`Không thể xóa khoản mục: ${error.message}`, true);
    }
  }

  $$('[data-nav]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); navigate(button.dataset.nav); }));
  $$('[data-open-form]').forEach((button) => button.addEventListener('click', () => openForm(button.dataset.openForm)));
  $('#activeSpaceSelect').addEventListener('change', (event) => { void switchSpace(event.target.value); });
  $$('[data-close-form]').forEach((button) => button.addEventListener('click', closeForm));
  $$('[data-open-settings]').forEach((button) => button.addEventListener('click', () => { renderConnection(); $('#settingsModal').hidden = false; }));
  $$('[data-close-settings]').forEach((button) => button.addEventListener('click', () => { $('#settingsModal').hidden = true; }));
  $$('[data-filter]').forEach((button) => button.addEventListener('click', async () => {
    filter = button.dataset.filter;
    $$('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
    try { await reloadTransactions(); }
    catch (error) { setCloudStatus(`Không thể tải giao dịch: ${error.message}`, true); }
  }));
  $$('[data-type]').forEach((button) => button.addEventListener('click', () => {
    transactionType = button.dataset.type;
    $$('[data-type]').forEach((item) => item.classList.toggle('active', item === button));
    updateCategories();
  }));
  $('#linkedBalanceInput').addEventListener('change', () => {
    $('#balanceEffectInput').disabled = !$('#linkedBalanceInput').value;
  });
  $('#loadMoreTransactions').addEventListener('click', async () => {
    if (!activeSpace || !data.transactionCursor || !data.hasMoreTransactions) return;
    $('#loadMoreTransactions').disabled = true;
    try {
      const page = await fetchTransactionPage(activeSpace.id, data.transactionCursor, filter);
      data.transactions.push(...page.transactions);
      data.hasMoreTransactions = page.hasMore;
      data.transactionCursor = page.cursor;
      renderTransactions();
    } catch (error) {
      setCloudStatus(`Không thể tải thêm giao dịch: ${error.message}`, true);
    } finally {
      $('#loadMoreTransactions').disabled = false;
    }
  });

  $('#categoryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#categoryError').hidden = true;
    try {
      const label = $('#categoryNameInput').value.trim();
      const { data: id, error } = await supabaseClient.rpc('create_transaction_category', {
        p_space_id: activeSpace.id,
        p_type: $('#categoryTypeInput').value,
        p_label: label,
      });
      if (error) throw error;
      data.categories.push({ id, type: $('#categoryTypeInput').value, label, is_archived: false });
      $('#categoryNameInput').value = '';
      updateCategories();
      renderCategoryManager();
    } catch (error) {
      $('#categoryError').textContent = `Không thể thêm danh mục: ${error.message}`;
      $('#categoryError').hidden = false;
    }
  });

  document.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-kind]');
    const transaction = event.target.closest('[data-delete-transaction]');
    const asset = event.target.closest('[data-delete-asset]');
    const debt = event.target.closest('[data-delete-debt]');
    const removeMember = event.target.closest('[data-remove-member]');
    const changeRole = event.target.closest('[data-member-role]');
    const revokeInvite = event.target.closest('[data-revoke-invite]');
    const archiveCategory = event.target.closest('[data-archive-category]');
    if (edit) editItem(edit.dataset.editKind, edit.dataset.editId);
    else if (transaction) void deleteBy(transaction.dataset.deleteTransaction, 'transaction');
    else if (asset) void deleteBy(asset.dataset.deleteAsset, 'asset');
    else if (debt) void deleteBy(debt.dataset.deleteDebt, 'debt');
    else if (archiveCategory) void (async () => {
      try {
        const { error } = await supabaseClient.rpc('archive_transaction_category', {
          p_space_id: activeSpace.id,
          p_category_id: archiveCategory.dataset.archiveCategory,
        });
        if (error) throw error;
        const category = data.categories.find((item) => item.id === archiveCategory.dataset.archiveCategory);
        if (category) category.is_archived = true;
        updateCategories();
        renderCategoryManager();
      } catch (error) {
        $('#categoryError').textContent = `Không thể lưu trữ danh mục: ${error.message}`;
        $('#categoryError').hidden = false;
      }
    })();
    else if (removeMember) void (async () => {
      try {
        const { error } = await supabaseClient.rpc('remove_space_member', { p_space_id: activeSpace.id, p_user_id: removeMember.dataset.removeMember });
        if (error) throw error;
        await renderFamilyManagement();
      } catch (error) { $('#familyError').textContent = `Không thể gỡ thành viên: ${error.message}`; $('#familyError').hidden = false; }
    })();
    else if (changeRole) void (async () => {
      try {
        const { error } = await supabaseClient.rpc('set_space_member_role', { p_space_id: activeSpace.id, p_user_id: changeRole.dataset.memberRole, p_role: changeRole.dataset.roleNext });
        if (error) throw error;
        await renderFamilyManagement();
      } catch (error) { $('#familyError').textContent = `Không thể thay đổi quyền: ${error.message}`; $('#familyError').hidden = false; }
    })();
    else if (revokeInvite) void (async () => {
      try {
        const { error } = await supabaseClient.rpc('revoke_space_invite', { p_invite_id: revokeInvite.dataset.revokeInvite, p_token: null });
        if (error) throw error;
        await renderFamilyManagement();
      } catch (error) { $('#inviteError').textContent = `Không thể thu hồi lời mời: ${error.message}`; $('#inviteError').hidden = false; }
    })();
  });
  document.addEventListener('contextmenu', (event) => {
    if (event.target.closest('[data-delete-transaction],[data-delete-asset],[data-delete-debt]')) event.preventDefault();
  });

  $('#financeForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const amount = Number($('#amountInput').value.replace(/[^\d]/g, ''));
    if (!Number.isSafeInteger(amount) || amount < 1) { $('#formError').textContent = 'Nhập số tiền hợp lệ lớn hơn 0.'; $('#formError').hidden = false; return; }
    try {
      let item;
      let table;
      if (formMode === 'transaction') {
        const linkedValue = $('#linkedBalanceInput').value;
        item = {
          id:editingItem?.id || makeId(), type:transactionType, amount, category:$('#categoryInput').value,
          note:$('#noteInput').value.trim(), date:editingItem?.date || new Date().toISOString(),
          linkedAssetId:linkedValue.startsWith('asset:') ? linkedValue.slice(6) : null,
          linkedDebtId:linkedValue.startsWith('debt:') ? linkedValue.slice(5) : null,
          balanceEffect:linkedValue ? $('#balanceEffectInput').value : null,
        };
        table = 'transactions';
      } else if (formMode === 'asset') {
        const name = $('#nameInput').value.trim();
        if (!name) { $('#formError').textContent = 'Vui lòng nhập tên tài sản.'; $('#formError').hidden = false; return; }
        item = { id:makeId(), name, kind:$('#assetKindInput').value, value:amount };
        table = 'assets';
      } else {
        const name = $('#debtNameInput').value.trim();
        if (!name) { $('#formError').textContent = 'Vui lòng nhập tên khoản nợ.'; $('#formError').hidden = false; return; }
        const dueDate = $('#dueDateInput').value;
        item = { id:makeId(), name, kind:$('#debtKindInput').value, amount, ...(dueDate ? { dueDate } : {}) };
        table = 'debts';
      }
      if (hasCloudSession()) {
        const payload = table === 'transactions' ? transactionPayload(item) : table === 'assets' ? assetPayload(item) : debtPayload(item);
        if (editingItem) {
          item.id = editingItem.id;
          payload.id = item.id;
          delete payload.user_id;
          const { data: updated, error } = await supabaseClient.from(table).update(payload)
            .eq('id', item.id).eq('space_id', activeSpace.id).select('id').maybeSingle();
          if (error) throw error;
          if (!updated) throw new Error('Khoản mục không còn tồn tại trong không gian này.');
        } else {
          const { error } = await supabaseClient.from(table).insert(payload);
          if (error) throw error;
        }
      } else {
        throw new Error('Bạn cần đăng nhập trước khi lưu dữ liệu.');
      }
      data = await loadSpaceData(activeSpace.id, filter);
      editingItem = null;
      closeForm();
      renderAll();
      setCloudStatus('');
    } catch (error) {
      $('#formError').textContent = `Không thể lưu khoản mục: ${error.message}`;
      $('#formError').hidden = false;
    }
  });

  $('#authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const action = event.submitter?.dataset.authAction || 'signin';
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    $('#authError').hidden = true;
    try {
      const result = action === 'signup'
        ? await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + window.location.pathname } })
        : await supabaseClient.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (action === 'signup' && !result.data.session) {
        $('#authError').textContent = 'Tài khoản đã tạo. Kiểm tra email để xác nhận trước khi đăng nhập.';
        $('#authError').hidden = false;
      }
    } catch (error) {
      $('#authError').textContent = `Không thể xác thực: ${error.message}`;
      $('#authError').hidden = false;
    }
  });

  $('#signOutButton').addEventListener('click', async () => {
    const { error } = await supabaseClient.auth.signOut();
    if (error) setCloudStatus(`Không thể đăng xuất: ${error.message}`, true);
  });

  $('#googleSignIn').addEventListener('click', async () => {
    $('#authError').hidden = true;
    try {
      const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;
    } catch (error) {
      $('#authError').textContent = `Không thể đăng nhập bằng Google: ${error.message}`;
      $('#authError').hidden = false;
    }
  });

  $('#uploadLocalData').addEventListener('click', async () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { alert('Không tìm thấy dữ liệu đã lưu trên thiết bị này.'); return; }
      const localData = JSON.parse(raw);
      validateData(localData);
      const count = localData.transactions.length + localData.assets.length + localData.debts.length;
      if (!confirm(`Thay thế dữ liệu trong tài khoản Supabase bằng ${localData.transactions.length} giao dịch, ${localData.assets.length} tài sản và ${localData.debts.length} khoản nợ trên thiết bị này? Dữ liệu đám mây hiện tại sẽ bị thay thế.`)) return;
      await replaceCloudData(localData);
      data = await loadSpaceData(activeSpace.id, filter);
      renderAll();
      setCloudStatus(`Đã chuyển ${count} khoản mục lên Supabase.`);
    } catch (error) {
      setCloudStatus(`Không thể chuyển dữ liệu: ${error.message}`, true);
    }
  });

  $('#exportBackup').addEventListener('click', async () => {
    try {
      if (!activeSpace) throw new Error('Không tìm thấy không gian tài chính hiện tại.');
      const backup = {
        format:'dong-tien-backup-v1',
        exportedAt:new Date().toISOString(),
        transactions:await fetchAllTransactions(activeSpace.id),
        assets:data.assets,
        debts:data.debts,
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `dong-tien-${new Date().toISOString().slice(0,10)}.json`; link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setCloudStatus(`Không thể tạo bản sao lưu: ${error.message}`, true);
    }
  });
  $('#importBackup').addEventListener('click', () => $('#backupFileInput').click());
  $('#backupFileInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.format !== 'dong-tien-backup-v1') throw new Error('Tệp không đúng định dạng sao lưu của Dòng Tiền.');
      const restored = { transactions: parsed.transactions, assets: parsed.assets, debts: parsed.debts };
      validateData(restored);
      if (!activeSpace || activeSpace.kind !== 'personal') throw new Error('Chỉ có thể khôi phục bản sao lưu trong không gian cá nhân.');
      if (!confirm(`Khôi phục dữ liệu: ${restored.transactions.length} giao dịch, ${restored.assets.length} tài sản và ${restored.debts.length} khoản nợ? Dữ liệu hiện tại sẽ bị thay thế.`)) return;
      if (!hasCloudSession()) throw new Error('Bạn cần đăng nhập trước khi khôi phục bản sao lưu.');
      await replaceCloudData(restored);
      data = await loadSpaceData(activeSpace.id, filter);
      renderAll();
      $('#settingsModal').hidden = true;
      setCloudStatus('Đã khôi phục dữ liệu.');
    } catch (error) {
      setCloudStatus(`Không thể khôi phục: ${error.message}`, true);
    }
    event.target.value = '';
  });
  $('#clearData').addEventListener('click', async () => {
    if (!activeSpace || activeSpace.kind !== 'personal') { setCloudStatus('Chỉ có thể xóa toàn bộ dữ liệu trong không gian cá nhân.', true); return; }
    if (!confirm('Xóa toàn bộ giao dịch, tài sản và khoản nợ hiện tại? Thao tác này không thể hoàn tác.')) return;
    try {
      await replaceCloudData(emptyData());
      data = await loadSpaceData(activeSpace.id, filter);
      renderAll();
      $('#settingsModal').hidden = true;
      setCloudStatus('Đã xóa dữ liệu hiện tại.');
    } catch (error) {
      setCloudStatus(`Không thể xóa dữ liệu: ${error.message}`, true);
    }
  });

  $('#createFamilyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#familyError').hidden = true;
    try {
      const { data: spaceId, error } = await supabaseClient.rpc('create_family_space', { p_name: $('#familyNameInput').value.trim() });
      if (error) throw error;
      $('#familyNameInput').value = '';
      await refreshSpaces(spaceId);
      sessionStorage.setItem('dong-tien-active-space', spaceId);
      setCloudStatus('Đã tạo không gian gia đình. Mời người thân tham gia để cùng theo dõi chi tiêu.');
    } catch (error) { $('#familyError').textContent = `Không thể tạo không gian: ${error.message}`; $('#familyError').hidden = false; }
  });

  $('#emailInviteForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#inviteError').hidden = true;
    try {
      const { error } = await supabaseClient.functions.invoke('send-invite', {
        body: { spaceId: activeSpace.id, email: $('#inviteEmailInput').value.trim() },
      });
      if (error) throw error;
      $('#inviteEmailInput').value = '';
      await renderFamilyManagement();
      setCloudStatus('Đã gửi lời mời email. Liên kết chỉ dùng một lần và hết hạn sau 7 ngày.');
    } catch (error) { $('#inviteError').textContent = `Không thể gửi lời mời: ${error.message}`; $('#inviteError').hidden = false; }
  });

  $('#createInviteLink').addEventListener('click', async () => {
    $('#inviteError').hidden = true;
    try {
      const { data: token, error } = await supabaseClient.rpc('create_space_invite', { p_space_id: activeSpace.id, p_email: null });
      if (error) throw error;
      const inviteUrl = new URL(window.location.href);
      inviteUrl.search = '';
      inviteUrl.hash = new URLSearchParams({ invite: token }).toString();
      $('#inviteLinkValue').value = inviteUrl.href;
      $('#inviteLinkResult').hidden = false;
      await renderFamilyManagement();
      setCloudStatus('Đã tạo liên kết mời dùng một lần, có hiệu lực trong 7 ngày.');
    } catch (error) { $('#inviteError').textContent = `Không thể tạo liên kết: ${error.message}`; $('#inviteError').hidden = false; }
  });
  $('#copyInviteLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#inviteLinkValue').value);
      $('#copyInviteLink').textContent = 'Đã sao chép';
    } catch (error) { $('#inviteError').textContent = `Không thể sao chép liên kết: ${error.message}`; $('#inviteError').hidden = false; }
  });
  $('#deleteFamilySpace').addEventListener('click', async () => {
    if (!confirm('Xóa không gian gia đình và toàn bộ giao dịch, tài sản, khoản nợ cùng lời mời? Thao tác này không thể hoàn tác.')) return;
    try {
      const deletedId = activeSpace.id;
      const { error } = await supabaseClient.rpc('delete_family_space', { p_space_id: deletedId });
      if (error) throw error;
      await refreshSpaces(spaces.find((space) => space.kind === 'personal' && space.id !== deletedId)?.id);
      setCloudStatus('Đã xóa không gian gia đình.');
    } catch (error) { $('#familyError').textContent = `Không thể xóa không gian: ${error.message}`; $('#familyError').hidden = false; }
  });

  updateCategories();
  renderAll();
  renderConnection();
  initializeSupabase();
})();

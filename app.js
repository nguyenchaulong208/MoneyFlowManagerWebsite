(() => {
  const STORAGE_KEY = 'dong-tien-finance-v1';
  const SCHEMA_KEY = 'dong-tien-finance-schema-version';
  const LAST_GOOD_KEY = 'dong-tien-finance-last-good-v1';
  const SCHEMA_VERSION = 1;
  const emptyData = () => ({ transactions: [], assets: [], debts: [] });
  let data = emptyData();
  let filter = 'all';
  let formMode = 'transaction';
  let transactionType = 'expense';
  let activeUser = null;
  let supabaseClient = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const formatMoney = (value) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(value) + ' ₫';
  const compactMoney = (value) => Math.abs(value) >= 1_000_000
    ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(value / 1_000_000) + ' tr'
    : formatMoney(value);
  const makeId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
  const hasCloudSession = () => Boolean(supabaseClient && activeUser);

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
    });
    value.assets.forEach((item) => {
      if (!item.id || typeof item.name !== 'string' || typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0) throw new Error('Tài sản trong tệp sao lưu không hợp lệ.');
    });
    value.debts.forEach((item) => {
      if (!item.id || typeof item.name !== 'string' || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0) throw new Error('Khoản nợ trong tệp sao lưu không hợp lệ.');
    });
  }

  function persist() {
    try {
      const previous = localStorage.getItem(STORAGE_KEY);
      if (previous) localStorage.setItem(LAST_GOOD_KEY, previous);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
      $('#storageNotice').hidden = true;
      return true;
    } catch {
      $('#storageNotice').textContent = 'Không thể lưu dữ liệu trên trình duyệt. Hãy kiểm tra quyền lưu trữ hoặc dung lượng thiết bị.';
      $('#storageNotice').hidden = false;
      return false;
    }
  }

  function loadLocalData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const schema = Number(localStorage.getItem(SCHEMA_KEY) || 0);
      if (schema > SCHEMA_VERSION) throw new Error('newer');
      if (raw) {
        const parsed = JSON.parse(raw);
        validateData(parsed);
        data = parsed;
      } else {
        const lastGood = localStorage.getItem(LAST_GOOD_KEY);
        if (lastGood) {
          const parsed = JSON.parse(lastGood);
          validateData(parsed);
          data = parsed;
          $('#storageNotice').textContent = 'Đã khôi phục bản lưu gần nhất.';
          $('#storageNotice').hidden = false;
        } else {
          data = emptyData();
        }
      }
      data.transactions.forEach((item) => item.note = typeof item.note === 'string' ? item.note : '');
    } catch (error) {
      data = emptyData();
      $('#storageNotice').textContent = error.message === 'newer'
        ? 'Dữ liệu được tạo bởi phiên bản mới hơn. Bản lưu sẽ không bị ghi đè.'
        : 'Không đọc được dữ liệu đã lưu. Hãy khôi phục từ tệp sao lưu JSON.';
      $('#storageNotice').hidden = false;
    }
  }

  function totals() {
    const totalIncome = data.transactions.reduce((sum, item) => sum + (item.type === 'income' ? item.amount : 0), 0);
    const totalExpense = data.transactions.reduce((sum, item) => sum + (item.type === 'expense' ? item.amount : 0), 0);
    const assetsValue = data.assets.reduce((sum, item) => sum + item.value, 0);
    const cashValue = data.assets.filter((item) => item.kind === 'cash').reduce((sum, item) => sum + item.value, 0);
    const debtsValue = data.debts.reduce((sum, item) => sum + item.amount, 0);
    return { totalIncome, totalExpense, assetsValue, cashValue, debtsValue, available: cashValue + totalIncome - totalExpense, netWorth: assetsValue + totalIncome - totalExpense - debtsValue };
  }

  function transactionRow(item, deletable = true) {
    const positive = item.type === 'income';
    const date = new Date(item.date).toLocaleDateString('vi-VN', { day: 'numeric', month: 'short' });
    return `<button class="transaction-row ${positive ? 'income' : ''}" ${deletable ? `data-delete-transaction="${escapeHtml(item.id)}" aria-label="Xóa giao dịch ${escapeHtml(item.note || item.category)}"` : ''}>
      <span class="icon">${positive ? '↗' : '◈'}</span><span class="transaction-main"><b>${escapeHtml(item.note || item.category)}</b><small>${escapeHtml(item.category)} · ${escapeHtml(date)}</small></span>
      <span class="transaction-amount ${positive ? 'income' : ''}">${positive ? '+' : '−'}${formatMoney(item.amount)}</span></button>`;
  }

  function empty(title, detail) {
    return `<div class="empty"><span>⌂</span><b>${escapeHtml(title)}</b><p>${escapeHtml(detail)}</p></div>`;
  }

  function renderOverview() {
    const t = totals();
    const now = new Date();
    const monthItems = data.transactions.filter((item) => { const d = new Date(item.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
    const income = monthItems.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
    const expense = monthItems.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
    $('#netWorth').textContent = formatMoney(t.netWorth);
    $('#availableValue').textContent = formatMoney(t.available);
    $('#debtValue').textContent = formatMoney(t.debtsValue);
    $('#monthLabel').textContent = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric' }).format(now);
    $('#todayLabel').textContent = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    $('#monthIncome').textContent = compactMoney(income);
    $('#monthExpense').textContent = compactMoney(expense);
    $('#recentTransactions').innerHTML = data.transactions.length ? data.transactions.slice(0, 4).map((item) => transactionRow(item, false)).join('') : empty('Bắt đầu ghi dòng tiền', 'Giao dịch đầu tiên sẽ xuất hiện ở đây. Dữ liệu được lưu riêng cho bạn.');
  }

  function renderTransactions() {
    const filtered = data.transactions.filter((item) => filter === 'all' || item.type === filter);
    const sum = filtered.reduce((total, item) => total + (item.type === 'income' ? item.amount : -item.amount), 0);
    $('#filteredCount').textContent = String(filtered.length);
    $('#filteredSum').textContent = (sum >= 0 ? '+' : '−') + formatMoney(Math.abs(sum));
    $('#filteredSum').style.color = sum >= 0 ? 'var(--primary)' : 'var(--danger)';
    $('#transactionList').innerHTML = filtered.length ? filtered.map(transactionRow).join('') : empty(filter === 'all' ? 'Chưa có giao dịch' : `Chưa có ${filter === 'income' ? 'thu nhập' : 'chi tiêu'}`, 'Thêm khoản đầu tiên để bắt đầu theo dõi dòng tiền.');
    $('#deleteHint').hidden = !filtered.length;
  }

  function renderAssets() {
    const t = totals();
    const assetTotal = t.assetsValue + t.totalIncome - t.totalExpense;
    $('#assetNetValue').textContent = formatMoney(assetTotal - t.debtsValue);
    $('#assetTotal').textContent = compactMoney(t.assetsValue);
    $('#debtTotal').textContent = compactMoney(t.debtsValue);
    const kindNames = { cash:'Tiền mặt & tiền gửi', investment:'Đầu tư', property:'Bất động sản', business:'Kinh doanh', other:'Tài sản khác' };
    $('#assetList').innerHTML = data.assets.length ? data.assets.map((asset) => `<button class="item-row" data-delete-asset="${escapeHtml(asset.id)}" aria-label="Xóa tài sản ${escapeHtml(asset.name)}"><span class="item-icon">▤</span><span class="item-main"><b>${escapeHtml(asset.name)}</b><small>${escapeHtml(kindNames[asset.kind] || 'Tài sản khác')}</small></span><span class="item-amount">${formatMoney(asset.value)}</span></button>`).join('') : empty('Chưa có tài sản', 'Thêm tiền mặt, khoản tiết kiệm, khoản đầu tư hoặc tài sản khác.');
    $('#debtList').innerHTML = data.debts.length ? data.debts.map((debt) => `<button class="item-row debt" data-delete-debt="${escapeHtml(debt.id)}" aria-label="Xóa khoản nợ ${escapeHtml(debt.name)}"><span class="item-icon">▤</span><span class="item-main"><b>${escapeHtml(debt.name)}</b><small>${escapeHtml(debt.kind)}${debt.dueDate ? ' · Hạn ' + escapeHtml(debt.dueDate) : ''}</small></span><span class="item-amount">${formatMoney(debt.amount)}</span></button>`).join('') : empty('Chưa có khoản nợ', 'Theo dõi dư nợ thẻ tín dụng, vay hoặc trả góp tại đây.');
  }

  function renderAnalysis() {
    const now = new Date();
    const monthItems = data.transactions.filter((item) => { const d = new Date(item.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
    const income = monthItems.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
    const expense = monthItems.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
    const grouped = new Map();
    monthItems.filter((item) => item.type === 'expense').forEach((item) => grouped.set(item.category, (grouped.get(item.category) || 0) + item.amount));
    const categories = [...grouped.entries()].sort((a,b) => b[1]-a[1]);
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
    $('#analysisInsight').textContent = !monthItems.length ? 'Khi bạn ghi nhận thu chi, các xu hướng trong tháng sẽ được tổng hợp tại đây.' : expense === 0 ? 'Tháng này chưa có khoản chi tiêu nào được ghi nhận.' : income === 0 ? `Khoản chi nhiều nhất hiện tại là ${largest}. Hãy thêm thu nhập để xem đầy đủ dòng tiền.` : income >= expense ? `Thu nhập tháng này cao hơn chi tiêu ${formatMoney(income-expense)}. Bạn đang giữ được dòng tiền dương.` : `Chi tiêu đang cao hơn thu nhập ${formatMoney(expense-income)}. Hãy xem lại nhóm ${largest}.`;
    const totalExpense = categories.reduce((sum, [,amount]) => sum + amount, 0);
    $('#categoryList').innerHTML = categories.length ? categories.map(([name,amount], index) => { const share = totalExpense ? amount/totalExpense : 0; return `<article class="category-row"><div class="category-head"><b>${escapeHtml(name)}</b><b>${formatMoney(amount)}</b></div><div class="category-bottom"><div class="track"><i style="width:${Math.max(share*100,3)}%;background:${index===0?'var(--primary)':'var(--gold)'}"></i></div><small>${Math.round(share*100)}%</small></div></article>`; }).join('') : empty('Chưa đủ dữ liệu phân tích', 'Thêm các khoản thu chi để xem tỷ trọng chi tiêu theo danh mục.');
  }

  function renderAll() { renderOverview(); renderTransactions(); renderAssets(); renderAnalysis(); }

  function setCloudStatus(message, isError = false) {
    const notice = $('#cloudStatus');
    notice.textContent = message;
    notice.classList.toggle('error', isError);
    notice.hidden = !message;
  }

  function renderConnection() {
    const configured = Boolean(supabaseClient);
    $('#authForm').hidden = !configured || Boolean(activeUser);
    $('#signedInControls').hidden = !activeUser;
    $('#uploadLocalData').hidden = !activeUser;
    $('#cloudSetupHint').hidden = configured;
    $('#connectionSummary').textContent = activeUser ? 'Đã kết nối — dữ liệu riêng tư trên Supabase' : configured ? 'Đăng nhập để đồng bộ dữ liệu giữa các thiết bị' : 'Đang lưu dữ liệu trên thiết bị này';
    $('#sidebarAccountStatus').textContent = activeUser ? activeUser.email : configured ? 'Chưa đăng nhập' : 'Lưu trên thiết bị';
    $('#privacyNoteText').textContent = activeUser ? 'Dữ liệu được đồng bộ riêng tư trên tài khoản của bạn.' : 'Dữ liệu của bạn luôn được giữ riêng tư trên thiết bị.';
    if (activeUser) $('#signedInEmail').textContent = activeUser.email;
  }

  function initializeSupabase() {
    const config = window.SUPABASE_CONFIG;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string' || !config.url || !config.anonKey) {
      renderConnection();
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      $('#cloudSetupHint').textContent = 'Không tải được thư viện Supabase. Kiểm tra kết nối mạng hoặc chặn nội dung CDN; dữ liệu trên thiết bị vẫn dùng được.';
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
    } catch (error) {
      $('#cloudSetupHint').textContent = error.message || 'Không thể khởi tạo kết nối Supabase. Kiểm tra tệp cấu hình.';
      renderConnection();
    }
  }

  async function handleSession(session) {
    const previousUserId = activeUser?.id || null;
    activeUser = session?.user || null;
    renderConnection();
    if (!activeUser) {
      if (previousUserId) {
        loadLocalData();
        renderAll();
      }
      return;
    }
    if (previousUserId === activeUser.id) return;
    data = emptyData();
    renderAll();
    try {
      await loadCloudData();
      setCloudStatus('');
      renderAll();
    } catch (error) {
      setCloudStatus(`Không tải được dữ liệu từ Supabase: ${error.message}`, true);
    }
  }

  async function loadCloudData() {
    const [transactions, assets, debts] = await Promise.all([
      supabaseClient.from('transactions').select('id,type,amount,category,note,date').order('date', { ascending: false }),
      supabaseClient.from('assets').select('id,name,kind,value').order('created_at', { ascending: false }),
      supabaseClient.from('debts').select('id,name,kind,amount,due_date').order('created_at', { ascending: false }),
    ]);
    for (const result of [transactions, assets, debts]) if (result.error) throw result.error;
    data = {
      transactions: transactions.data.map((item) => ({ ...item, amount: Number(item.amount), note: item.note || '' })),
      assets: assets.data.map((item) => ({ ...item, value: Number(item.value) })),
      debts: debts.data.map((item) => ({ id:item.id, name:item.name, kind:item.kind, amount:Number(item.amount), ...(item.due_date ? { dueDate:item.due_date } : {}) })),
    };
  }

  function transactionPayload(item) {
    return { id:item.id, user_id:activeUser.id, type:item.type, amount:item.amount, category:item.category, note:item.note || '', date:item.date };
  }
  function assetPayload(item) {
    return { id:item.id, user_id:activeUser.id, name:item.name, kind:item.kind, value:item.value };
  }
  function debtPayload(item) {
    return { id:item.id, user_id:activeUser.id, name:item.name, kind:item.kind, amount:item.amount, due_date:item.dueDate || null };
  }

  async function replaceCloudData(replacement) {
    const { error } = await supabaseClient.rpc('replace_financial_data', {
      p_transactions: replacement.transactions.map(transactionPayload),
      p_assets: replacement.assets.map(assetPayload),
      p_debts: replacement.debts.map(debtPayload),
    });
    if (error) throw error;
  }

  function navigate(page) {
    $$('.page').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
    $$('[data-nav]').forEach((item) => item.classList.toggle('active', item.dataset.nav === page));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openForm(mode) {
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
    $('#formError').hidden = true;
    updateCategories();
    $('#formModal').hidden = false;
  }

  function updateCategories() {
    const expenseCategories = ['Ăn uống','Di chuyển','Nhà ở','Mua sắm','Khác'];
    const incomeCategories = ['Lương','Kinh doanh','Khác'];
    $('#categoryInput').innerHTML = (transactionType === 'income' ? incomeCategories : expenseCategories).map((item) => `<option>${escapeHtml(item)}</option>`).join('');
  }

  function closeForm() { $('#formModal').hidden = true; }

  async function deleteBy(id, kind) {
    if (!confirm('Xóa khoản mục này? Thao tác này không thể hoàn tác.')) return;
    try {
      if (hasCloudSession()) {
        const table = kind === 'transaction' ? 'transactions' : kind === 'asset' ? 'assets' : 'debts';
        const { error } = await supabaseClient.from(table).delete().eq('id', id).eq('user_id', activeUser.id);
        if (error) throw error;
      }
      if (kind === 'transaction') data.transactions = data.transactions.filter((item) => item.id !== id);
      if (kind === 'asset') data.assets = data.assets.filter((item) => item.id !== id);
      if (kind === 'debt') data.debts = data.debts.filter((item) => item.id !== id);
      if (!hasCloudSession()) persist();
      renderAll();
    } catch (error) {
      setCloudStatus(`Không thể xóa khoản mục: ${error.message}`, true);
    }
  }

  $$('[data-nav]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); navigate(button.dataset.nav); }));
  $$('[data-open-form]').forEach((button) => button.addEventListener('click', () => openForm(button.dataset.openForm)));
  $$('[data-close-form]').forEach((button) => button.addEventListener('click', closeForm));
  $$('[data-open-settings]').forEach((button) => button.addEventListener('click', () => { renderConnection(); $('#settingsModal').hidden = false; }));
  $$('[data-close-settings]').forEach((button) => button.addEventListener('click', () => { $('#settingsModal').hidden = true; }));
  $$('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; $$('[data-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderTransactions(); }));
  $$('[data-type]').forEach((button) => button.addEventListener('click', () => { transactionType = button.dataset.type; $$('[data-type]').forEach((item) => item.classList.toggle('active', item === button)); updateCategories(); }));

  document.addEventListener('click', (event) => {
    const transaction = event.target.closest('[data-delete-transaction]');
    const asset = event.target.closest('[data-delete-asset]');
    const debt = event.target.closest('[data-delete-debt]');
    if (transaction) void deleteBy(transaction.dataset.deleteTransaction, 'transaction');
    else if (asset) void deleteBy(asset.dataset.deleteAsset, 'asset');
    else if (debt) void deleteBy(debt.dataset.deleteDebt, 'debt');
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
        item = { id:makeId(), type:transactionType, amount, category:$('#categoryInput').value, note:$('#noteInput').value.trim(), date:new Date().toISOString() };
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
        const { error } = await supabaseClient.from(table).insert(payload);
        if (error) throw error;
      }
      if (table === 'transactions') data.transactions.unshift(item);
      else if (table === 'assets') data.assets.unshift(item);
      else data.debts.unshift(item);
      if (!hasCloudSession()) persist();
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
        ? await supabaseClient.auth.signUp({ email, password })
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

  $('#uploadLocalData').addEventListener('click', async () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { alert('Không tìm thấy dữ liệu đã lưu trên thiết bị này.'); return; }
      const localData = JSON.parse(raw);
      validateData(localData);
      const count = localData.transactions.length + localData.assets.length + localData.debts.length;
      if (!confirm(`Thay thế dữ liệu trong tài khoản Supabase bằng ${localData.transactions.length} giao dịch, ${localData.assets.length} tài sản và ${localData.debts.length} khoản nợ trên thiết bị này? Dữ liệu đám mây hiện tại sẽ bị thay thế.`)) return;
      await replaceCloudData(localData);
      data = localData;
      renderAll();
      setCloudStatus(`Đã chuyển ${count} khoản mục lên Supabase.`);
    } catch (error) {
      setCloudStatus(`Không thể chuyển dữ liệu: ${error.message}`, true);
    }
  });

  $('#exportBackup').addEventListener('click', () => {
    const backup = { format:'dong-tien-backup-v1', exportedAt:new Date().toISOString(), ...data };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `dong-tien-${new Date().toISOString().slice(0,10)}.json`; link.click();
    URL.revokeObjectURL(url);
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
      if (!confirm(`Khôi phục dữ liệu: ${restored.transactions.length} giao dịch, ${restored.assets.length} tài sản và ${restored.debts.length} khoản nợ? Dữ liệu hiện tại sẽ bị thay thế.`)) return;
      if (hasCloudSession()) await replaceCloudData(restored);
      data = restored;
      if (!hasCloudSession()) persist();
      renderAll();
      $('#settingsModal').hidden = true;
      setCloudStatus('Đã khôi phục dữ liệu.');
    } catch (error) {
      setCloudStatus(`Không thể khôi phục: ${error.message}`, true);
    }
    event.target.value = '';
  });
  $('#clearData').addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ giao dịch, tài sản và khoản nợ hiện tại? Thao tác này không thể hoàn tác.')) return;
    try {
      if (hasCloudSession()) {
        await replaceCloudData(emptyData());
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SCHEMA_KEY);
        localStorage.removeItem(LAST_GOOD_KEY);
      }
      data = emptyData();
      renderAll();
      $('#settingsModal').hidden = true;
      setCloudStatus('Đã xóa dữ liệu hiện tại.');
    } catch (error) {
      setCloudStatus(`Không thể xóa dữ liệu: ${error.message}`, true);
    }
  });

  loadLocalData();
  updateCategories();
  renderAll();
  renderConnection();
  initializeSupabase();
})();

(() => {
  const STORAGE_KEY = 'dong-tien-finance-v1';
  const emptySummary = () => ({
    transaction_count: 0, income_count: 0, expense_count: 0,
    total_income: 0, total_expense: 0, month_income: 0, month_expense: 0, month_net_cash_flow: 0,
    assets_value: 0, cash_value: 0, liquid_assets_value: 0, debts_value: 0, liabilities_value: 0,
    net_worth: 0, income_expense_ratio: null, savings_rate: null,
    monthly_debt_repayments: 0, monthly_borrowing: 0, monthly_asset_purchases: 0,
    assets_by_type: [], liabilities_by_type: [], month_categories: [],
  });
  const emptyData = () => ({
    transactions: [], recentTransactions: [], assets: [], debts: [], liquidAssets: [], categories: [], financeTypes: [], movements: [],
    summary: emptySummary(), hasMoreTransactions: false, transactionCursor: null,
    hasMoreAssets: false, assetCursor: null, hasMoreDebts: false, debtCursor: null,
    hasMoreMovements: false, movementCursor: null,
    hasMoreLiquidAssets: false, liquidAssetCursor: null,
  });
  const STARTUP_TIMEOUT_MS = 15000;
  let data = emptyData();
  let filter = 'all';
  let formMode = 'transaction';
  let transactionType = 'expense';
  let activeUser = null;
  let activeSpace = null;
  let liquidAssetsExpanded = false;
  let spaces = [];
  let editingItem = null;
  let authLoading = true;
  let loadingUserId = null;
  let authGeneration = 0;
  let spaceSwitchGeneration = 0;
  let switchingSpace = false;
  let authStateRevision = 0;
  let sessionCheckGeneration = 0;
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
  function financialNumber(value, field) {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) {
      const error = new Error(`Dữ liệu tài chính không hợp lệ tại trường ${field}.`);
      error.name = 'InvalidFinancialDataError';
      error.code = 'INVALID_FINANCIAL_DATA';
      throw error;
    }
    return parsed;
  }
  function financialArray(value, field) {
    if (value == null) return [];
    if (!Array.isArray(value)) {
      const error = new Error(`Dữ liệu tài chính không hợp lệ tại trường ${field}.`);
      error.name = 'InvalidFinancialDataError';
      error.code = 'INVALID_FINANCIAL_DATA';
      throw error;
    }
    return value;
  }
  function financialObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const error = new Error(`Dữ liệu tài chính không hợp lệ tại trường ${field}.`);
      error.name = 'InvalidFinancialDataError';
      error.code = 'INVALID_FINANCIAL_DATA';
      throw error;
    }
    return value;
  }
  const optionalFinancialNumber = (value, field, fallback = null) =>
    value == null || value === '' ? fallback : financialNumber(value, field);
  const formatMoney = (value) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 })
    .format(financialNumber(value, 'số tiền')) + ' ₫';
  const compactMoney = (value) => {
    const amount = financialNumber(value, 'số tiền');
    return Math.abs(amount) >= 1_000_000
      ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(amount / 1_000_000) + ' tr'
      : formatMoney(amount);
  };
  const formatRatio = (value) => value == null
    ? 'Chưa đủ dữ liệu'
    : `${(financialNumber(value, 'tỷ lệ') * 100).toFixed(1)}%`;
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
    if (value.movements !== undefined && !Array.isArray(value.movements)) throw new Error('Lịch sử biến động trong tệp sao lưu không hợp lệ.');
    value.transactions.forEach((item) => {
      if (!item.id || !['income','expense'].includes(item.type) || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0 || !item.category || !Number.isFinite(Date.parse(item.date))) throw new Error('Giao dịch trong tệp sao lưu không hợp lệ.');
      const linkedAssetId = item.linkedAssetId || item.linked_asset_id;
      const linkedDebtId = item.linkedDebtId || item.linked_debt_id;
      const balanceEffect = item.balanceEffect || item.balance_effect;
      const linkedAssetId2 = item.linkedAssetId2 || item.linked_asset_id_2;
      const linkedDebtId2 = item.linkedDebtId2 || item.linked_debt_id_2;
      const balanceEffect2 = item.balanceEffect2 || item.balance_effect_2;
      if ((linkedAssetId && linkedDebtId) || (linkedAssetId2 && linkedDebtId2)
        || ((linkedAssetId || linkedDebtId) && !['increase', 'decrease'].includes(balanceEffect))
        || ((linkedAssetId2 || linkedDebtId2) && !['increase', 'decrease'].includes(balanceEffect2))
        || (linkedAssetId && linkedAssetId === linkedAssetId2)
        || (linkedDebtId && linkedDebtId === linkedDebtId2)) {
        throw new Error('Liên kết số dư trong tệp sao lưu không hợp lệ.');
      }
    });
    value.assets.forEach((item) => {
      if (!item.id || typeof item.name !== 'string' || typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0) throw new Error('Tài sản trong tệp sao lưu không hợp lệ.');
    });
    value.debts.forEach((item) => {
      if (!item.id || typeof item.name !== 'string' || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0) throw new Error('Khoản nợ trong tệp sao lưu không hợp lệ.');
    });
    (value.movements || []).forEach((item) => {
      if (!item.id || !['asset', 'liability'].includes(item.account_kind) || !item.account_id
        || !Number.isSafeInteger(Number(item.amount))
        || !['opening', 'adjustment', 'purchase', 'transfer', 'borrowing', 'repayment', 'transaction', 'transaction_reversal', 'restore_adjustment'].includes(item.movement_type)
        || !Number.isFinite(Date.parse(item.occurred_at)) || !Number.isFinite(Date.parse(item.created_at))) {
        throw new Error('Biến động số dư trong tệp sao lưu không hợp lệ.');
      }
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
    const linkedName = linkedAsset?.name || linkedDebt?.name || item.linkedAssetName || item.linkedDebtName;
    const linkedName2 = item.linkedAssetId2
      ? data.assets.find((asset) => asset.id === item.linkedAssetId2)?.name || item.linkedAssetName2
      : item.linkedDebtId2 ? data.debts.find((debt) => debt.id === item.linkedDebtId2)?.name || item.linkedDebtName2 : '';
    return `<div class="transaction-row ${positive ? 'income' : ''}">
      <span class="icon">${positive ? '↗' : '◈'}</span><span class="transaction-main"><b>${escapeHtml(item.note || item.category)}</b><small>${escapeHtml(item.category)} · ${escapeHtml(date)}${linkedName ? ' · ↔ ' + escapeHtml(linkedName) : ''}${linkedName2 ? ' · ↔ ' + escapeHtml(linkedName2) : ''}</small></span>
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
    $('#overviewAssetTotal').textContent = formatMoney(t.assetsValue);
    $('#overviewLiquidTotal').textContent = formatMoney(data.summary.liquid_assets_value);
    const liquidList = $('#liquidAssetsList');
    liquidList.classList.toggle('expanded', liquidAssetsExpanded);
    liquidList.innerHTML = data.liquidAssets.length
      ? data.liquidAssets.map((asset) => `<div class="liquid-asset-row"><span>${escapeHtml(asset.name)} · ${escapeHtml(asset.account_type_label)}</span><strong>${formatMoney(asset.value)}</strong></div>`).join('')
      : '<p class="hint">Chưa có tài sản thuộc loại thanh khoản.</p>';
    const toggleLiquidAssets = $('#toggleLiquidAssets');
    toggleLiquidAssets.hidden = !data.hasMoreLiquidAssets && !liquidAssetsExpanded;
    toggleLiquidAssets.textContent = liquidAssetsExpanded ? 'Thu gọn' : 'Xem thêm';
    toggleLiquidAssets.ariaExpanded = String(liquidAssetsExpanded);
    $('#loadMoreLiquidAssets').hidden = !liquidAssetsExpanded || !data.hasMoreLiquidAssets;
    $('#monthLabel').textContent = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric' }).format(now);
    $('#todayLabel').textContent = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    $('#monthIncome').textContent = compactMoney(data.summary.month_income);
    $('#monthExpense').textContent = compactMoney(data.summary.month_expense);
    $('#monthNet').textContent = (data.summary.month_net_cash_flow >= 0 ? '+' : '−') + formatMoney(Math.abs(data.summary.month_net_cash_flow));
    $('#savingsRate').textContent = formatRatio(data.summary.savings_rate);
    const savings = data.summary.savings_rate ?? 0;
    $('#savingsBar').style.width = savings > 0 ? Math.max(savings * 100, savings ? 4 : 0) + '%' : '0';
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
    $('#assetList').innerHTML = data.assets.length ? data.assets.map((asset) => `<div class="item-row"><span class="item-icon">▤</span><span class="item-main"><b>${escapeHtml(asset.name)}</b><small>${escapeHtml(asset.account_type_label || asset.kind)}${asset.is_liquid ? ' · Thanh khoản' : ''}</small></span><span class="item-amount">${formatMoney(asset.value)}</span><span class="row-actions"><button type="button" data-edit-kind="asset" data-edit-id="${escapeHtml(asset.id)}">Sửa</button><button type="button" data-delete-asset="${escapeHtml(asset.id)}" aria-label="Lưu trữ tài sản">Lưu trữ</button></span></div>`).join('') : empty('Chưa có tài sản', 'Thêm tiền mặt, khoản tiết kiệm, khoản đầu tư hoặc tài sản khác.');
    $('#debtList').innerHTML = data.debts.length ? data.debts.map((debt) => `<div class="item-row debt"><span class="item-icon">▤</span><span class="item-main"><b>${escapeHtml(debt.name)}</b><small>${escapeHtml(debt.account_type_label || debt.kind)}${debt.dueDate ? ' · Hạn ' + escapeHtml(debt.dueDate) : ''}</small></span><span class="item-amount">${formatMoney(debt.amount)}</span><span class="row-actions"><button type="button" data-edit-kind="debt" data-edit-id="${escapeHtml(debt.id)}">Sửa</button><button type="button" data-delete-debt="${escapeHtml(debt.id)}" aria-label="Lưu trữ khoản phải trả">Lưu trữ</button></span></div>`).join('') : empty('Chưa có khoản nợ', 'Theo dõi dư nợ thẻ tín dụng, vay hoặc trả góp tại đây.');
    $('#loadMoreAssets').hidden = !data.hasMoreAssets;
    $('#loadMoreDebts').hidden = !data.hasMoreDebts;
    $('#movementList').innerHTML = data.movements.length ? data.movements.map((movement) => {
      const date = new Date(movement.occurred_at).toLocaleDateString('vi-VN', { day: 'numeric', month: 'short' });
      const labels = { opening:'Số dư ban đầu', adjustment:'Điều chỉnh', purchase:'Mua tài sản', transfer:'Chuyển khoản', borrowing:'Vay mới', repayment:'Trả nợ', transaction:'Giao dịch', transaction_reversal:'Đảo giao dịch', restore_adjustment:'Điều chỉnh khôi phục' };
      return `<div class="item-row movement-row"><span class="item-icon">↕</span><span class="item-main"><b>${escapeHtml(movement.account_name)}</b><small>${escapeHtml(labels[movement.movement_type] || movement.movement_type)} · ${escapeHtml(date)}${movement.note ? ' · ' + escapeHtml(movement.note) : ''}</small></span><span class="item-amount ${movement.amount < 0 ? 'negative' : ''}">${movement.amount >= 0 ? '+' : '−'}${formatMoney(Math.abs(movement.amount))}</span></div>`;
    }).join('') : empty('Chưa có biến động số dư', 'Các khoản điều chỉnh, chuyển khoản và giao dịch liên kết sẽ được lưu tại đây.');
    $('#loadMoreMovements').hidden = !data.hasMoreMovements;
  }

  function renderAnalysis() {
    const now = new Date();
    const period = reportPeriod();
    const income = data.summary.month_income;
    const expense = data.summary.month_expense;
    const netCashFlow = data.summary.month_net_cash_flow;
    const categories = data.summary.month_categories.map((item) => [item.category, item.amount]);
    const month = new Intl.DateTimeFormat('vi-VN', { month:'long', year:'numeric' }).format(now);
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString('vi-VN', { month:'long', year:'numeric' });
    const largest = categories[0]?.[0] || '—';

    // So sánh tháng trước
    const cmp = data.comparison || {};
    $('#analysisMonth').textContent = month;
    $('#analysisPeriodDescription').textContent = period.label;
    $('#analysisIncome').textContent = formatMoney(income);
    $('#analysisExpense').textContent = formatMoney(expense);
    $('#analysisNet').textContent = (netCashFlow >= 0 ? '+' : '−') + formatMoney(Math.abs(netCashFlow));
    $('#analysisNet').style.color = netCashFlow >= 0 ? 'var(--primary)' : 'var(--danger)';

    // So sánh với tháng trước
    if (cmp.income_variance != null || cmp.expense_variance != null) {
      const incomeDiff = cmp.income_variance || 0;
      const expenseDiff = cmp.expense_variance || 0;
      const netDiff = cmp.net_variance || 0;
      const incomeChangePct = cmp.income_change_pct;
      const expenseChangePct = cmp.expense_change_pct;
      const incomeChangeText = cmp.income_change_text || '';
      const expenseChangeText = cmp.expense_change_text || '';

      const compareCard = $('#comparisonCard');
      const compareStatus = $('#comparisonStatus');
      compareCard.hidden = false;
      compareCard.style.display = 'flex';

      const prevIncome = income - incomeDiff;
      const prevExpense = expense - expenseDiff;

      compareCard.innerHTML = `
        <span class="compare-icon">⇄</span>
        <div>
          <p>SO SÁNG VỚI THÁNG TRƯỚC</p>
          <small>${prevMonth}</small>
        </div>
        <div class="compare-items">
          <div class="compare-item">
            <span class="compare-label">Thu nhập</span>
            <span class="compare-value">${formatMoney(prevIncome)}</span>
            <span class="compare-change ${incomeDiff >= 0 ? 'up' : 'down'}">${incomeDiff >= 0 ? '+' : ''}${formatMoney(Math.abs(incomeDiff))}</span>
          </div>
          <div class="compare-item">
            <span class="compare-label">Chi tiêu</span>
            <span class="compare-value">${formatMoney(prevExpense)}</span>
            <span class="compare-change ${expenseDiff >= 0 ? 'up' : 'down'}">${expenseDiff >= 0 ? '+' : ''}${formatMoney(Math.abs(expenseDiff))}</span>
          </div>
          <div class="compare-item">
            <span class="compare-label">Dòng tiền</span>
            <span class="compare-value">${netDiff >= 0 ? '+' : '−'}${formatMoney(Math.abs(netDiff))}</span>
          </div>
        </div>
      `;
      compareStatus.textContent = 'Dòng tiền tháng này ' + (netDiff >= 0 ? 'càng' : 'kém') + (Math.abs(netDiff) > 0 ? ' so với tháng trước' : ' đồng bằng');
    } else {
      $('#comparisonCard').hidden = true;
      $('#comparisonActions').hidden = true;
    }

    const max = Math.max(income, expense);
    $('#incomeBar').style.width = max ? Math.max(income/max*100, income ? 4 : 0) + '%' : '0';
    $('#expenseBar').style.width = max ? Math.max(expense/max*100, expense ? 4 : 0) + '%' : '0';
    const ratio = data.summary.income_expense_ratio;
    const savings = data.summary.savings_rate;

    const metrics = [
      ['TỔNG TÀI SẢN', formatMoney(data.summary.assets_value), 'Số dư hiện tại, không phải định giá thị trường.'],
      ['TÀI SẢN THANH KHOẢN', formatMoney(data.summary.liquid_assets_value), 'Tài sản có loại được bật tính thanh khoản.'],
      ['TỔNG NỢ', formatMoney(data.summary.debts_value), 'Dư nợ hiện tại của các khoản đang hoạt động.'],
      ['TÀI SẢN RÒNG', formatMoney(data.summary.net_worth), 'Tổng tài sản hiện tại trừ tổng nợ.'],
      ['THU NHẬP TRONG KỲ', formatMoney(income), 'Tổng giao dịch thu trong kỳ báo cáo.'],
      ['CHI TIÊU TRONG KỲ', formatMoney(expense), 'Tổng giao dịch chi trong kỳ báo cáo.'],
      ['DÒNG TIỀN RÒNG', (netCashFlow >= 0 ? '+' : '−') + formatMoney(Math.abs(netCashFlow)), 'Thu nhập trong kỳ trừ chi tiêu trong kỳ.'],
      ['TỶ LỆ CHI / THU', formatRatio(ratio), 'Chi tiêu trong kỳ ÷ thu nhập trong kỳ; chưa đủ dữ liệu khi chưa có thu nhập.'],
      ['TỶ LỆ TIẾT KIỆM', formatRatio(savings), 'Dòng tiền ròng trong kỳ ÷ thu nhập trong kỳ; chưa đủ dữ liệu khi chưa có thu nhập.'],
      ['TRẢ NỢ TRONG KỲ', formatMoney(data.summary.monthly_debt_repayments), 'Tổng các khoản trả nợ được ghi nhận trong kỳ.'],
      ['VAY MỚI TRONG KỲ', formatMoney(data.summary.monthly_borrowing), 'Tổng các khoản vay mới được ghi nhận trong kỳ.'],
      ['MUA TÀI SẢN TRONG KỲ', formatMoney(data.summary.monthly_asset_purchases), 'Tổng giá trị mua tài sản được ghi nhận trong kỳ.'],
    ];
    $('#reportMetrics').innerHTML = metrics.map(([label, value, formula]) => `<article class="metric-card"><small>${label}</small><b>${value}</b><span>${formula}</span></article>`).join('');
    const renderBreakdown = (items) => items.length ? items.map((item) => `<div class="category-row"><div class="category-head"><b>${escapeHtml(item.type)}</b><b>${formatMoney(item.amount)}</b></div></div>`).join('') : '<p class="hint">Chưa có dữ liệu.</p>';
    $('#assetsByType').innerHTML = renderBreakdown(data.summary.assets_by_type);
    $('#liabilitiesByType').innerHTML = renderBreakdown(data.summary.liabilities_by_type);
    const totalExpense = categories.reduce((sum, [,amount]) => sum + amount, 0);
    $('#categoryList').innerHTML = categories.length ? categories.map(([name,amount], index) => { const share = totalExpense ? amount/totalExpense : 0; return `<article class="category-row"><div class="category-head"><b>${escapeHtml(name)}</b><b>${formatMoney(amount)}</b></div><div class="category-bottom"><div class="track"><i style="width:${Math.max(share*100,3)}%;background:${index===0?'var(--primary)':'var(--gold)'}"></i></div><small>${Math.round(share*100)}%</small></div></article>`; }).join('') : empty('Chưa đủ dữ liệu phân tích', 'Thêm các khoản thu chi để xem tỷ trọng chi tiêu theo danh mục.');
    if (categories.length > 1) {
      const total = categories.reduce((sum, [,amount]) => sum + amount, 0);
      const stops = categories.map(([name, amount], i) => {
        const pct = ((amount / total) * 100).toFixed(1);
        const color = i === 0 ? 'var(--primary)' : 'var(--gold)';
        return `${color} ${Math.max((i === 0 ? 0 : 0) + (categories.slice(0, i).reduce((s, [,a]) => s + (a / total) * 100, 0)), 0)}% ${Math.max((i === 0 ? 0 : 0) + (categories.slice(0, i).reduce((s, [,a]) => s + (a / total) * 100, 0)), 0) + parseFloat(pct)}%`;
      }).join(', ');
      $('#categoryDonut').innerHTML = `
        <div class="donut-wrap">
          <div class="donut-center"><b>${formatMoney(total)}</b><small>chi tiêu tháng</small></div>
          <div style="position:absolute;inset:4px;clip-path:polygon(0 0,100% 0,100% 100%,0 100%);background:conic-gradient(${stops})"></div>
        </div>
        <div class="donut-legend">${categories.map(([name, amount], i) => `<div class="legend-item"><span class="swatch" style="background:${i === 0 ? 'var(--primary)' : 'var(--gold)'}"></span>${escapeHtml(name)} <b>${formatMoney(amount)}</b></div>`).join('')}</div>
      `;
    } else {
      $('#categoryDonut').innerHTML = '<p class="hint">Thêm nhiều danh mục để xem biểu đồ phân bổ.</p>';
    }
  }

  function renderCategoryManager() {
    $('#categoryManager').innerHTML = data.categories.map((category) => `<div class="member-row">
      <input class="manager-label" data-category-label="${escapeHtml(category.id)}" value="${escapeHtml(category.label)}" maxlength="60" aria-label="Tên danh mục" ${category.is_archived ? 'disabled' : ''} />
      <select class="manager-type" data-category-type="${escapeHtml(category.id)}" aria-label="Loại danh mục" ${category.is_archived ? 'disabled' : ''}>
        <option value="expense" ${category.type === 'expense' ? 'selected' : ''}>Chi tiêu</option>
        <option value="income" ${category.type === 'income' ? 'selected' : ''}>Thu nhập</option>
      </select>
      ${category.is_archived ? '<small>Đã lưu trữ</small>' : ''}
      ${category.is_archived ? '' : `<button type="button" data-save-category="${escapeHtml(category.id)}">Lưu thay đổi</button><button type="button" data-archive-category="${escapeHtml(category.id)}">Lưu trữ</button>`}
    </div>`).join('') || '<p class="hint">Chưa có danh mục.</p>';
  }

  function renderFinanceTypeManager() {
    $('#financeTypeManager').innerHTML = data.financeTypes.map((type) => `<div class="member-row">
      <input class="manager-label" data-finance-type-label="${escapeHtml(type.id)}" value="${escapeHtml(type.label)}" maxlength="60" aria-label="Tên loại tài khoản" ${type.is_archived ? 'disabled' : ''} />
      <small>${type.account_kind === 'asset' ? 'Tài sản' : 'Khoản phải trả'}${type.is_liquid ? ' · Thanh khoản' : ''}${type.is_archived ? ' · Đã lưu trữ' : ''}</small>
      ${type.account_kind === 'asset' && !type.is_archived ? `<label class="liquid-toggle"><input type="checkbox" data-finance-type-liquid="${escapeHtml(type.id)}" ${type.is_liquid ? 'checked' : ''} /> Thanh khoản</label>` : ''}
      ${type.is_archived ? '' : `<button type="button" data-save-finance-type="${escapeHtml(type.id)}">Lưu thay đổi</button><button type="button" data-archive-finance-type="${escapeHtml(type.id)}">Lưu trữ</button>`}
    </div>`).join('') || '<p class="hint">Chưa có loại tài khoản.</p>';
  }

  function renderAll() { renderOverview(); renderTransactions(); renderAssets(); renderAnalysis(); renderCategoryManager(); renderFinanceTypeManager(); }

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
    $('#authGateRetry').hidden = !supabaseClient || !authGateError || authLoading;
    $('#authGateRetry').disabled = authLoading;
    $('#authGateSettings').textContent = signedIn ? 'Mở cài đặt tài khoản' : 'Đăng nhập hoặc tạo tài khoản';
    if (authGateError) {
      $('#authGateTitle').textContent = 'Không thể mở dữ liệu tài chính';
      $('#authGateMessage').textContent = authGateError;
    } else if (!configured) {
      $('#authGateTitle').textContent = 'Cần kết nối Supabase';
      $('#authGateMessage').textContent = 'Thiết lập URL và public key của Supabase để đăng nhập. Dữ liệu tài chính không được mở ở chế độ chưa xác thực.';
    } else if (switchingSpace) {
      $('#authGateTitle').textContent = 'Đang chuyển không gian tài chính…';
      $('#authGateMessage').textContent = 'Đang tải dữ liệu cho không gian đã chọn. Không gian hiện tại sẽ được giữ nếu không thể hoàn tất.';
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
        authStateRevision += 1;
        void handleSession(session);
      });
      void checkAuthSession();
    } catch (error) {
      authLoading = false;
      const knownConfigErrors = [
        'Cấu hình Supabase chưa hợp lệ. Hãy thay URL và anon key mẫu trong supabase-config.js.',
        'Không dùng service-role/secret key trong website. Hãy dùng anon/public (publishable) key.',
      ];
      authGateError = knownConfigErrors.includes(error.message)
        ? error.message
        : 'Không thể khởi tạo kết nối Supabase. Kiểm tra URL và public key trong tệp cấu hình.';
      $('#cloudSetupHint').textContent = authGateError;
      renderConnection();
    }
  }

  function withStartupTimeout(request, operation) {
    let timerId;
    const timeout = new Promise((_, reject) => {
      timerId = window.setTimeout(() => {
        const error = new Error('Startup request timed out');
        error.name = 'StartupTimeoutError';
        error.operation = operation;
        reject(error);
      }, STARTUP_TIMEOUT_MS);
    });
    return Promise.race([Promise.resolve(request), timeout]).finally(() => window.clearTimeout(timerId));
  }

  function startupErrorCode(error) {
    return typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(error.code)
      ? error.code : '';
  }

  function rpcWithName(name, args) {
    return Promise.resolve(supabaseClient.rpc(name, args)).then((result) => {
      return {
        ...result,
        error: result.error ? { ...result.error, rpcName: name } : null,
      };
    }).catch((error) => {
      return {
        data: null,
        error: {
          message: error.message || 'RPC failure',
          code: error.code || 'RPC_ERROR',
          rpcName: name,
        },
      };
    });
  }

  function startupErrorMessage(operation, error) {
    const messages = {
      session: 'Không thể xác nhận phiên đăng nhập.',
      invite: 'Không thể xác nhận lời mời tham gia.',
      spaces: 'Không thể tải danh sách không gian tài chính.',
      data: 'Không thể tải dữ liệu tài chính.',
      family: 'Không thể tải thông tin không gian gia đình.',
    };
    const reason = error?.name === 'StartupTimeoutError'
      ? ' Máy chủ phản hồi quá lâu.'
      : ' Kiểm tra kết nối, cấu hình Supabase và các migration.';
    const code = startupErrorCode(error);
    if (error?.name === 'InvalidFinancialDataError') {
      return `${messages[operation] || 'Không thể khởi động ứng dụng.'} ${error.message} Vui lòng tải lại; dữ liệu gốc chưa bị thay đổi.`;
    }
    const rpcName = error?.rpcName;
    const knownRpc = typeof rpcName === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(rpcName);
    if (error?.code === 'PGRST202' && knownRpc) {
      const requiredMigration = {
        list_space_transactions: '20261127010000',
        list_space_assets: '20261127010000',
        list_space_liabilities: '20261127010000',
        list_space_balance_movements: '20261127010000',
        list_space_liquid_assets: '20261127120000',
        get_space_financial_summary_v2: '20261127120000',
      }[rpcName];
      const migrationHint = requiredMigration
        ? ` Kiểm tra migration ${requiredMigration} (cùng các migration trước đó) đã chạy thành công.`
        : '';
      return `${messages[operation] || 'Không thể khởi động ứng dụng.'} Không tìm thấy RPC ${rpcName} trong schema API (PGRST202).${migrationHint} Nếu hàm đã tồn tại trong database, hãy nạp lại schema cache của PostgREST. Hãy thử lại; dữ liệu đã lưu không bị xóa. (mã ${code})`;
    }
    if (knownRpc && code) {
      if (code === '42883' && rpcName === 'get_space_financial_summary_comparison') {
        return `${messages[operation] || 'Không thể khởi động ứng dụng.'} RPC ${rpcName} gặp lỗi PostgreSQL 42883. Cập nhật schema bằng migration 20261127140000 rồi thử lại; dữ liệu đã lưu không bị xóa.`;
      }
      return `${messages[operation] || 'Không thể khởi động ứng dụng.'} RPC ${rpcName} thất bại (mã ${code}). Kiểm tra migration và cấu hình database; dữ liệu đã lưu không bị xóa.`;
    }
    return `${messages[operation] || 'Không thể khởi động ứng dụng.'}${reason} Hãy thử lại; dữ liệu đã lưu không bị xóa.${code ? ` (mã ${code})` : ''}`;
  }

  function failAuthStartup(operation, error, generation = null) {
    if (generation !== null && generation !== authGeneration) return;
    authGeneration += 1;
    loadingUserId = null;
    activeSpace = null;
    spaces = [];
    data = emptyData();
    authLoading = false;
    authGateError = startupErrorMessage(operation, error);
    const code = startupErrorCode(error);
    console.warn('Finance startup request failed', {
      operation,
      timedOut: error?.name === 'StartupTimeoutError',
      code: code || undefined,
      rpcName: typeof error?.rpcName === 'string' ? error.rpcName : undefined,
    });
    renderConnection();
    renderAll();
    setCloudStatus(authGateError, true);
  }

  async function checkAuthSession() {
    if (!supabaseClient) return;
    const checkGeneration = ++sessionCheckGeneration;
    const stateRevision = authStateRevision;
    authLoading = true;
    authGateError = '';
    setCloudStatus('');
    renderConnection();
    try {
      const { data: result, error } = await withStartupTimeout(supabaseClient.auth.getSession(), 'session');
      if (checkGeneration !== sessionCheckGeneration || stateRevision !== authStateRevision) return;
      if (error) throw error;
      await handleSession(result.session);
    } catch (error) {
      if (checkGeneration !== sessionCheckGeneration || stateRevision !== authStateRevision) return;
      failAuthStartup('session', error);
    }
  }

  async function handleSession(session) {
    const previousUserId = activeUser?.id || null;
    activeUser = session?.user || null;
    if (!activeUser) {
      spaceSwitchGeneration += 1;
      switchingSpace = false;
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
    if (previousUserId && previousUserId !== activeUser.id) {
      spaceSwitchGeneration += 1;
      switchingSpace = false;
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
    let operation = 'invite';
    try {
      if (pendingInviteToken) {
        const { error } = await withStartupTimeout(
          supabaseClient.rpc('accept_space_invite', { p_token: pendingInviteToken }),
          operation,
        );
        if (error) throw error;
        pendingInviteToken = null;
        sessionStorage.removeItem('dong-tien-pending-invite');
        window.history.replaceState(null, '', window.location.pathname);
        setCloudStatus('Đã tham gia không gian gia đình.');
      }
      operation = 'spaces';
      if (!await withStartupTimeout(loadSpaces(generation), operation)) return;
      const savedSpaceId = sessionStorage.getItem('dong-tien-active-space');
      const savedSpace = spaces.find((space) => space.id === savedSpaceId);
      activeSpace = savedSpace
        || spaces.find((space) => space.kind === 'personal')
        || spaces.find((space) => space.owner_id === activeUser.id)
        || spaces[0]
        || null;
      if (!activeSpace) throw new Error('Tài khoản chưa có không gian tài chính. Hãy chạy lại supabase/schema.sql.');
      $('#activeSpaceSelect').value = activeSpace.id;
      sessionStorage.setItem('dong-tien-active-space', activeSpace.id);
      operation = 'data';
      const loadedData = await withStartupTimeout(loadSpaceData(activeSpace.id, filter), operation);
      if (generation !== authGeneration) return;
      data = loadedData;
      setCloudStatus('');
      authLoading = false;
      loadingUserId = null;
      renderConnection();
      renderAll();
      operation = 'family';
      await withStartupTimeout(renderFamilyManagement(), operation);
    } catch (error) {
      if (generation !== authGeneration) return;
      failAuthStartup(operation, error, generation);
    }
  }

  async function loadSpaces(generation) {
    const { data: result, error } = await supabaseClient.from('spaces').select('id,name,kind,owner_id').order('created_at');
    if (error) throw error;
    if (generation !== undefined && generation !== authGeneration) return false;
    spaces = result ?? [];
    $('#activeSpaceSelect').innerHTML = spaces.map((space) =>
      `<option value="${escapeHtml(space.id)}">${escapeHtml(space.kind === 'family' ? 'Gia đình · ' : 'Cá nhân · ')}${escapeHtml(space.name)}</option>`
    ).join('');
    $('#spacePickerWrap').hidden = spaces.length < 2;
    return true;
  }

  function reportPeriod() {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const dateFormatter = new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
      start: startDate.toISOString(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
      label: `${dateFormatter.format(startDate)} – ${dateFormatter.format(endDate)}`,
    };
  }

  function normalizeTransaction(item) {
    return {
      ...item,
      amount: financialNumber(item.amount, 'giao dịch.amount'),
      note: item.note || '',
      linkedAssetId: item.linked_asset_id || null,
      linkedDebtId: item.linked_debt_id || null,
      balanceEffect: item.balance_effect || null,
      linkedAssetId2: item.linked_asset_id_2 || null,
      linkedDebtId2: item.linked_debt_id_2 || null,
      balanceEffect2: item.balance_effect_2 || null,
      balanceMovementType: item.balance_movement_type || 'transaction',
      balanceMovementType2: item.balance_movement_type_2 || 'transaction',
      linkedAssetName: item.linked_asset_name || null,
      linkedDebtName: item.linked_debt_name || null,
      linkedAssetName2: item.linked_asset_name_2 || null,
      linkedDebtName2: item.linked_debt_name_2 || null,
    };
  }

  async function fetchTransactionPage(spaceId, cursor, transactionTypeFilter, limit = 50) {
    const { data: result, error } = await rpcWithName('list_space_transactions', {
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
    let attempts = 0;
    const maxAttempts = 100;
    while (hasMore && attempts < maxAttempts) {
      try {
        const page = await fetchTransactionPage(spaceId, cursor, 'all', 100);
        transactions.push(...page.transactions);
        hasMore = page.hasMore;
        cursor = page.cursor;
        attempts++;
      } catch (error) {
        attempts++;
        if (attempts >= maxAttempts) throw error;
      }
    }
    return transactions;
  }

  async function fetchAccountPage(spaceId, kind, cursor, limit = 50, includeArchived = false) {
    const isAsset = kind === 'asset';
    const { data: result, error } = await rpcWithName(isAsset ? 'list_space_assets' : 'list_space_liabilities', {
      p_space_id: spaceId,
      p_before_created_at: cursor?.createdAt || null,
      p_before_id: cursor?.id || null,
      p_limit: limit + 1,
      p_include_archived: includeArchived,
    });
    if (error) throw error;
    const hasMore = result.length > limit;
    const items = result.slice(0, limit).map((item) => isAsset
      ? { ...item, value: financialNumber(item.value, 'tài sản.value'), accountTypeId: item.account_type_id, account_type_label: item.account_type_label, is_liquid: item.is_liquid }
      : { ...item, amount: financialNumber(item.amount, 'khoản nợ.amount'), dueDate: item.due_date || null, accountTypeId: item.account_type_id, account_type_label: item.account_type_label });
    const last = items[items.length - 1];
    return { items, hasMore, cursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null };
  }

  async function fetchLiquidAssetPage(spaceId, cursor, limit = 4) {
    const { data: result, error } = await rpcWithName('list_space_liquid_assets', {
      p_space_id: spaceId,
      p_before_created_at: cursor?.createdAt || null,
      p_before_id: cursor?.id || null,
      p_limit: limit + 1,
    });
    if (error) throw error;
    const hasMore = result.length > limit;
    const items = result.slice(0, limit).map((item) => ({ ...item, value: financialNumber(item.value, 'tài sản thanh khoản.value') }));
    const last = items[items.length - 1];
    return { items, hasMore, cursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null };
  }

  async function fetchAllAccounts(spaceId, kind, includeArchived = false) {
    const items = [];
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const page = await fetchAccountPage(spaceId, kind, cursor, 100, includeArchived);
      items.push(...page.items);
      hasMore = page.hasMore;
      cursor = page.cursor;
    }
    return items;
  }

  async function fetchAllMovements(spaceId) {
    const movements = [];
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const page = await fetchMovementPage(spaceId, cursor, 100);
      movements.push(...page.movements);
      hasMore = page.hasMore;
      cursor = page.cursor;
    }
    return movements;
  }

  async function fetchMovementPage(spaceId, cursor, limit = 50) {
    const { data: result, error } = await rpcWithName('list_space_balance_movements', {
      p_space_id: spaceId,
      p_before_created_at: cursor?.createdAt || null,
      p_before_id: cursor?.id || null,
      p_limit: limit + 1,
    });
    if (error) throw error;
    const hasMore = result.length > limit;
    const movements = result.slice(0, limit).map((item) => ({ ...item, amount: financialNumber(item.amount, 'biến động.amount') }));
    const last = movements[movements.length - 1];
    return { movements, hasMore, cursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null };
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
    const [transactionPage, recentPage, assets, debts, liquidAssets, categories, financeTypes, movements, summaryV2, comparison] = await Promise.all([
        fetchTransactionPage(spaceId, null, transactionTypeFilter),
        fetchTransactionPage(spaceId, null, 'all', 4),
        fetchAccountPage(spaceId, 'asset', null),
        fetchAccountPage(spaceId, 'liability', null),
        fetchLiquidAssetPage(spaceId, null),
        supabaseClient.from('transaction_categories').select('id,type,label,is_archived').eq('space_id', spaceId).order('type').order('label'),
        supabaseClient.from('space_finance_types').select('id,account_kind,code,label,is_liquid,is_archived').eq('space_id', spaceId).order('account_kind').order('label'),
        fetchMovementPage(spaceId, null),
        rpcWithName('get_space_financial_summary_v2', {
          p_space_id: spaceId,
          p_month_start: period.start,
          p_month_end: period.end,
        }),
        rpcWithName('get_space_financial_summary_comparison', {
          p_space_id: spaceId,
          p_month_start: period.start,
          p_month_end: period.end,
        }),
      ]);
    const results = [transactionPage, recentPage, assets, debts, liquidAssets, categories, financeTypes, movements, summaryV2, comparison];
    for (const result of results) {
      if (result?.error) throw result.error;
    }
    const totals = financialObject(summaryV2.data, 'summary');
    const cmp = comparison.data == null ? {} : financialObject(comparison.data, 'comparison');
    const monthIncome = financialNumber(totals.month_income, 'month_income');
    const monthExpense = financialNumber(totals.month_expense, 'month_expense');
    const assetsValue = financialNumber(totals.assets_value, 'assets_value');
    const debtsValue = financialNumber(totals.debts_value ?? totals.liabilities_value, 'debts_value');
    const cashValue = optionalFinancialNumber(totals.cash_value ?? totals.liquid_assets_value, 'cash_value', 0);
    const assetsByType = financialArray(totals.assets_by_type, 'assets_by_type').map((item, index) => {
      const value = financialObject(item, `assets_by_type[${index}]`);
      return { ...value, amount: financialNumber(value.amount, `assets_by_type[${index}].amount`) };
    });
    const liabilitiesByType = financialArray(totals.liabilities_by_type, 'liabilities_by_type').map((item, index) => {
      const value = financialObject(item, `liabilities_by_type[${index}]`);
      return { ...value, amount: financialNumber(value.amount, `liabilities_by_type[${index}].amount`) };
    });
    const monthCategories = financialArray(totals.month_categories, 'month_categories').map((item, index) => {
      const value = financialObject(item, `month_categories[${index}]`);
      return { ...value, amount: financialNumber(value.amount, `month_categories[${index}].amount`) };
    });
    const optionalText = (value, field) => {
      if (value == null || value === '') return '';
      if (typeof value !== 'string') {
        const error = new Error(`Dữ liệu tài chính không hợp lệ tại trường ${field}.`);
        error.name = 'InvalidFinancialDataError';
        error.code = 'INVALID_FINANCIAL_DATA';
        throw error;
      }
      return value;
    };
    const monthNetCashFlow = optionalFinancialNumber(
      totals.month_net_cash_flow,
      'month_net_cash_flow',
      monthIncome - monthExpense,
    );
    const netWorth = optionalFinancialNumber(totals.net_worth, 'net_worth', assetsValue - debtsValue);
    const liquidAssetsValue = optionalFinancialNumber(totals.liquid_assets_value, 'liquid_assets_value', cashValue);
    return {
      transactions: transactionPage.transactions,
      recentTransactions: recentPage.transactions,
      assets: assets.items,
      debts: debts.items,
      liquidAssets: liquidAssets.items,
      categories: categories.data || [],
      financeTypes: financeTypes.data || [],
      movements: movements.movements,
      summary: {
        transaction_count: financialNumber(totals.transaction_count, 'transaction_count'),
        income_count: financialNumber(totals.income_count, 'income_count'),
        expense_count: financialNumber(totals.expense_count, 'expense_count'),
        total_income: financialNumber(totals.total_income, 'total_income'),
        total_expense: financialNumber(totals.total_expense, 'total_expense'),
        month_income: monthIncome,
        month_expense: monthExpense,
        month_net_cash_flow: monthNetCashFlow,
        assets_value: assetsValue,
        cash_value: cashValue,
        liquid_assets_value: liquidAssetsValue,
        debts_value: debtsValue,
        liabilities_value: optionalFinancialNumber(totals.liabilities_value, 'liabilities_value', debtsValue),
        net_worth: netWorth,
        income_expense_ratio: optionalFinancialNumber(totals.income_expense_ratio, 'income_expense_ratio'),
        savings_rate: optionalFinancialNumber(totals.savings_rate, 'savings_rate'),
        monthly_debt_repayments: optionalFinancialNumber(
          totals.monthly_debt_repayments ?? totals.month_debt_repayments,
          'monthly_debt_repayments',
          0,
        ),
        monthly_borrowing: optionalFinancialNumber(totals.monthly_borrowing, 'monthly_borrowing', 0),
        monthly_asset_purchases: optionalFinancialNumber(totals.monthly_asset_purchases, 'monthly_asset_purchases', 0),
        assets_by_type: assetsByType,
        liabilities_by_type: liabilitiesByType,
        month_categories: monthCategories,
      },
      comparison: {
        income_variance: optionalFinancialNumber(cmp.income_variance, 'comparison.income_variance', 0),
        expense_variance: optionalFinancialNumber(cmp.expense_variance, 'comparison.expense_variance', 0),
        net_variance: optionalFinancialNumber(cmp.net_variance, 'comparison.net_variance', 0),
        income_change_pct: optionalFinancialNumber(cmp.income_change_pct, 'comparison.income_change_pct'),
        expense_change_pct: optionalFinancialNumber(cmp.expense_change_pct, 'comparison.expense_change_pct'),
        income_change_text: optionalText(cmp.income_change_text, 'comparison.income_change_text'),
        expense_change_text: optionalText(cmp.expense_change_text, 'comparison.expense_change_text'),
        savings_rate: optionalFinancialNumber(cmp.savings_rate, 'comparison.savings_rate'),
        expense_ratio: optionalFinancialNumber(cmp.expense_ratio, 'comparison.expense_ratio'),
      },
      hasMoreTransactions: transactionPage.hasMore,
      transactionCursor: transactionPage.cursor,
      hasMoreAssets: assets.hasMore,
      assetCursor: assets.cursor,
      hasMoreDebts: debts.hasMore,
      debtCursor: debts.cursor,
      hasMoreMovements: movements.hasMore,
      movementCursor: movements.cursor,
      hasMoreLiquidAssets: liquidAssets.hasMore,
      liquidAssetCursor: liquidAssets.cursor,
    };
  }

  function transactionPayload(item) {
    return {
      id:item.id, user_id:activeUser.id, space_id:activeSpace.id,
      type:item.type, amount:item.amount, category:item.category, note:item.note || '', date:item.date,
      linked_asset_id:item.linkedAssetId || null, linked_debt_id:item.linkedDebtId || null,
      balance_effect:item.balanceEffect || null,
      linked_asset_id_2:item.linkedAssetId2 || null, linked_debt_id_2:item.linkedDebtId2 || null,
      balance_effect_2:item.balanceEffect2 || null,
      balance_movement_type:item.balanceMovementType || null,
      balance_movement_type_2:item.balanceMovementType2 || null,
    };
  }
  function getAccountTypeId(kind, accountTypeId, code) {
    const rawCode = String(code || '');
    const debtCode = kind === 'liability' ? ({
      'vay':'loan', 'thẻ tín dụng':'credit-card', 'trả góp':'installment', 'khác':'other',
    }[rawCode.toLocaleLowerCase('vi')] || rawCode) : rawCode;
    const type = data.financeTypes.find((item) => item.id === accountTypeId && item.account_kind === kind)
      || data.financeTypes.find((item) => item.code === debtCode && item.account_kind === kind)
      || data.financeTypes.find((item) => item.account_kind === kind && item.label.toLocaleLowerCase('vi') === rawCode.toLocaleLowerCase('vi'))
      || data.financeTypes.find((item) => item.account_kind === kind && item.code === 'other');
    if (!type) throw new Error('Không tìm thấy loại tài khoản phù hợp trong không gian này.');
    return type.id;
  }
  function assetPayload(item) {
    const typeId = getAccountTypeId('asset', item.accountTypeId || item.account_type_id, item.kind);
    return { id:item.id, user_id:activeUser.id, space_id:activeSpace.id, name:item.name, kind:item.kind, value:item.value, account_type_id:typeId, is_archived:Boolean(item.is_archived) };
  }
  function debtPayload(item) {
    const typeId = getAccountTypeId('liability', item.accountTypeId || item.account_type_id, item.kind);
    return { id:item.id, user_id:activeUser.id, space_id:activeSpace.id, name:item.name, kind:item.kind, amount:item.amount, due_date:item.dueDate || null, account_type_id:typeId, is_archived:Boolean(item.is_archived) };
  }

  async function replaceCloudData(replacement) {
    if (!activeSpace || activeSpace.kind !== 'personal') throw new Error('Sao lưu, khôi phục và xóa toàn bộ chỉ áp dụng cho không gian cá nhân.');
    const { error } = await supabaseClient.rpc('replace_financial_data', {
      p_space_id: activeSpace.id,
      p_transactions: replacement.transactions.map(transactionPayload),
      p_assets: replacement.assets.map(assetPayload),
      p_debts: replacement.debts.map(debtPayload),
      p_movements: replacement.movements || [],
    });
    if (error) throw error;
  }

  async function renderFamilyManagement() {
    const space = activeSpace;
    $('#familyControls').hidden = !activeUser;
    $('#spaceManagement').hidden = !space || space.kind !== 'family';
    $('#familyError').hidden = true;
    $('#inviteError').hidden = true;
    if (!space || space.kind !== 'family') return;

    $('#familySpaceTitle').textContent = space.name;
    const [{ data: members, error: membersError }, { data: ownMembership, error: ownError }] = await Promise.all([
      supabaseClient.from('space_members').select('user_id,member_email,role').eq('space_id', space.id).order('created_at'),
      supabaseClient.from('space_members').select('role').eq('space_id', space.id).eq('user_id', activeUser.id).single(),
    ]);
    if (membersError) throw membersError;
    if (ownError) throw ownError;
    if (activeSpace?.id !== space.id) return;
    $('#deleteFamilySpace').hidden = space.owner_id !== activeUser.id;
    const canManage = ['owner', 'admin'].includes(ownMembership.role);
    const isOwner = space.owner_id === activeUser.id;
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
        .eq('space_id', space.id).order('created_at', { ascending: false });
      if (error) throw error;
      if (activeSpace?.id !== space.id) return;
      $('#inviteList').innerHTML = invites.length ? invites.map((invite) => {
        const status = invite.accepted_at ? 'Đã tham gia' : invite.revoked_at ? 'Đã thu hồi' : Date.parse(invite.expires_at) <= Date.now() ? 'Đã hết hạn' : 'Đang chờ';
        const revoke = status === 'Đang chờ' ? `<button type="button" data-revoke-invite="${escapeHtml(invite.id)}">Thu hồi</button>` : '';
        return `<div class="member-row"><span>${escapeHtml(invite.invited_email || 'Liên kết chia sẻ')}</span><small>${status}</small>${revoke}</div>`;
      }).join('') : '<p class="hint">Chưa có lời mời.</p>';
    }
  }

  async function switchSpace(spaceId) {
    const generation = ++spaceSwitchGeneration;
    const nextSpace = spaces.find((space) => space.id === spaceId);
    if (!nextSpace) {
      if (switchingSpace) {
        switchingSpace = false;
        authLoading = false;
        renderConnection();
      }
      $('#activeSpaceSelect').value = activeSpace?.id || '';
      return;
    }
    if (nextSpace.id === activeSpace?.id) {
      if (switchingSpace) {
        switchingSpace = false;
        authLoading = false;
        setCloudStatus('');
        renderConnection();
      }
      $('#activeSpaceSelect').value = nextSpace.id;
      return;
    }
    switchingSpace = true;
    authLoading = true;
    setCloudStatus(`Đang tải không gian “${nextSpace.name}”…`);
    renderConnection();
    let operation = 'data';
    try {
      const loadedData = await withStartupTimeout(loadSpaceData(nextSpace.id, filter), operation);
      if (generation !== spaceSwitchGeneration) return;
      activeSpace = nextSpace;
      data = loadedData;
      liquidAssetsExpanded = false;
      sessionStorage.setItem('dong-tien-active-space', nextSpace.id);
      $('#activeSpaceSelect').value = nextSpace.id;
      switchingSpace = false;
      authLoading = false;
      renderConnection();
      renderAll();
      setCloudStatus('');
      operation = 'family';
      try {
        await withStartupTimeout(renderFamilyManagement(), operation);
      } catch (error) {
        if (generation !== spaceSwitchGeneration) return;
        setCloudStatus(startupErrorMessage(operation, error), true);
      }
    } catch (error) {
      if (generation !== spaceSwitchGeneration) return;
      switchingSpace = false;
      authLoading = false;
      $('#activeSpaceSelect').value = activeSpace?.id || '';
      renderConnection();
      renderAll();
      setCloudStatus(startupErrorMessage(operation, error), true);
    }
  }

  async function refreshSpaces(nextSpaceId) {
    const generation = ++authGeneration;
    authLoading = true;
    activeSpace = null;
    data = emptyData();
    liquidAssetsExpanded = false;
    renderConnection();
    renderAll();
    let operation = 'spaces';
    try {
      if (!await withStartupTimeout(loadSpaces(generation), operation)) return false;
      activeSpace = spaces.find((space) => space.id === nextSpaceId) || spaces.find((space) => space.kind === 'personal') || spaces[0];
      if (!activeSpace) throw new Error('Không tìm thấy không gian tài chính.');
      $('#activeSpaceSelect').value = activeSpace.id;
      operation = 'data';
      const loadedData = await withStartupTimeout(loadSpaceData(activeSpace.id, filter), operation);
      if (generation !== authGeneration) return;
      data = loadedData;
      sessionStorage.setItem('dong-tien-active-space', activeSpace.id);
      authLoading = false;
      renderConnection();
      renderAll();
      operation = 'family';
      await withStartupTimeout(renderFamilyManagement(), operation);
      return true;
    } catch (error) {
      if (generation !== authGeneration) return;
      if (nextSpaceId) sessionStorage.setItem('dong-tien-active-space', nextSpaceId);
      failAuthStartup(operation, error, generation);
      return false;
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
    $('#formTitle').textContent = mode === 'transaction' ? 'Ghi giao dịch' : mode === 'asset' ? 'Thêm tài sản' : mode === 'debt' ? 'Thêm khoản nợ' : 'Ghi biến động số dư';
    $('#transactionTypeGroup').hidden = mode !== 'transaction';
    $('#transactionFields').hidden = mode !== 'transaction';
    $('#assetFields').hidden = mode !== 'asset';
    $('#debtFields').hidden = mode !== 'debt';
    $('#movementFields').hidden = mode !== 'movement';
    $('#amountInput').value = '';
    $('#nameInput').value = '';
    $('#debtNameInput').value = '';
    $('#noteInput').value = '';
    $('#dueDateInput').value = '';
    $('#linkedBalanceInput').value = '';
    $('#linkedBalanceInput2').value = '';
    $('#linkedBalanceSearch').value = '';
    $('#linkedBalanceSearch2').value = '';
    $('#balanceEffectInput').value = 'increase';
    $('#balanceEffectInput2').value = 'increase';
    $('#balanceMovementTypeInput').value = 'transaction';
    $('#balanceMovementTypeInput2').value = 'transaction';
    $('#movementNoteInput').value = '';
    $('#movementModeInput').value = 'adjustment';
    $('#movementDirectionInput').value = 'increase';
    $('#formError').hidden = true;
    $('#financeForm .submit').textContent = 'Lưu khoản mục →';
    updateAccountTypeOptions();
    updateCategories();
    updateLinkedBalances();
    updateMovementInputs();
    $('#formModal').hidden = false;
  }

  function editItem(kind, id) {
    const collection = kind === 'transaction' ? data.transactions : kind === 'asset' ? data.assets : data.debts;
    const item = collection.find((entry) => entry.id === id);
    if (!item) return;
    openForm(kind);
    editingItem = item;
    updateAccountTypeOptions();
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
      $('#linkedBalanceInput2').value = item.linkedAssetId2
        ? `asset:${item.linkedAssetId2}`
        : item.linkedDebtId2 ? `debt:${item.linkedDebtId2}` : '';
      $('#balanceEffectInput').value = item.balanceEffect || 'increase';
      $('#balanceEffectInput2').value = item.balanceEffect2 || 'increase';
      $('#balanceMovementTypeInput').value = item.balance_movement_type || 'transaction';
      $('#balanceMovementTypeInput2').value = item.balance_movement_type_2 || 'transaction';
      $('#balanceEffectInput').disabled = !$('#linkedBalanceInput').value;
      $('#balanceEffectInput2').disabled = !$('#linkedBalanceInput2').value;
    } else if (kind === 'asset') {
      $('#nameInput').value = item.name;
      $('#assetKindInput').value = item.accountTypeId;
    } else {
      $('#debtNameInput').value = item.name;
      $('#debtKindInput').value = item.accountTypeId;
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
    const linkedOptions = [];
    if (editingItem?.linkedAssetId) linkedOptions.push({ value:`asset:${editingItem.linkedAssetId}`, label:`Tài sản · ${editingItem.linkedAssetName || editingItem.linkedAssetId}` });
    if (editingItem?.linkedDebtId) linkedOptions.push({ value:`debt:${editingItem.linkedDebtId}`, label:`Khoản phải trả · ${editingItem.linkedDebtName || editingItem.linkedDebtId}` });
    if (editingItem?.linkedAssetId2) linkedOptions.push({ value:`asset:${editingItem.linkedAssetId2}`, label:`Tài sản · ${editingItem.linkedAssetName2 || editingItem.linkedAssetId2}` });
    if (editingItem?.linkedDebtId2) linkedOptions.push({ value:`debt:${editingItem.linkedDebtId2}`, label:`Khoản phải trả · ${editingItem.linkedDebtName2 || editingItem.linkedDebtId2}` });
    const optionsHtml = linkedOptions.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('');
    $('#linkedBalanceInput').innerHTML = '<option value="">Không liên kết</option>' + optionsHtml;
    $('#linkedBalanceInput2').innerHTML = '<option value="">Không liên kết</option>' + optionsHtml;
    $('#balanceEffectInput').disabled = !$('#linkedBalanceInput').value;
    $('#balanceEffectInput2').disabled = !$('#linkedBalanceInput2').value;
  }

  function updateAccountTypeOptions() {
    const renderTypes = (kind, selectedId) => data.financeTypes
      .filter((item) => item.account_kind === kind && (!item.is_archived || item.id === selectedId))
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}${item.is_archived ? ' · Đã lưu trữ' : ''}</option>`)
      .join('');
    $('#assetKindInput').innerHTML = renderTypes('asset', editingItem?.accountTypeId);
    $('#debtKindInput').innerHTML = renderTypes('liability', editingItem?.accountTypeId);
    if (!editingItem && $('#assetKindInput').options.length) {
      const liquidType = data.financeTypes.find((item) => item.account_kind === 'asset' && item.is_liquid && !item.is_archived);
      $('#assetKindInput').value = liquidType?.id || $('#assetKindInput').options[0].value;
    }
    if (!editingItem && $('#debtKindInput').options.length) $('#debtKindInput').value = $('#debtKindInput').options[0].value;
  }

  async function searchAccountOptions(searchInput, select, prompt) {
    const query = searchInput.value.trim();
    if (query.length < 2) {
      select.innerHTML = `<option value="">${escapeHtml(prompt)}</option>`;
      return;
    }
    const requestId = Number(searchInput.dataset.requestId || 0) + 1;
    searchInput.dataset.requestId = String(requestId);
    try {
      const { data: accounts, error } = await supabaseClient.rpc('search_space_accounts', {
        p_space_id: activeSpace.id, p_query: query, p_limit: 25,
      });
      if (error) throw error;
      if (searchInput.dataset.requestId !== String(requestId)) return;
      select.innerHTML = `<option value="">${accounts.length ? 'Chọn tài khoản' : 'Không tìm thấy tài khoản'}</option>` +
        accounts.map((account) => `<option value="${escapeHtml(account.account_kind)}:${escapeHtml(account.id)}">${escapeHtml(account.account_kind === 'asset' ? 'Tài sản' : 'Khoản phải trả')} · ${escapeHtml(account.name)} · ${escapeHtml(account.account_type_label)}</option>`).join('');
    } catch (error) {
      if (searchInput.dataset.requestId === String(requestId)) setCloudStatus(`Không thể tìm tài khoản: ${error.message}`, true);
    }
  }

  function updateMovementInputs() {
    const isAdjustment = $('#movementModeInput').value === 'adjustment';
    $('#movementDirectionLabel').hidden = !isAdjustment;
    $('#movementDestinationSearchLabel').hidden = isAdjustment;
    $('#movementDestinationSelectLabel').hidden = isAdjustment;
  }

  function syncLinkedMovementType(changedInput) {
    const first = changedInput.id === 'balanceMovementTypeInput';
    const otherType = first ? $('#balanceMovementTypeInput2') : $('#balanceMovementTypeInput');
    const otherLink = first ? $('#linkedBalanceInput2') : $('#linkedBalanceInput');
    const firstLink = $('#linkedBalanceInput').value;
    const secondLink = $('#linkedBalanceInput2').value;
    if (otherLink.value) otherType.value = changedInput.value;
    if (changedInput.value === 'repayment') {
      if (firstLink) $('#balanceEffectInput').value = 'decrease';
      if (secondLink) $('#balanceEffectInput2').value = 'decrease';
    } else if (changedInput.value === 'borrowing') {
      if (firstLink) $('#balanceEffectInput').value = 'increase';
      if (secondLink) $('#balanceEffectInput2').value = 'increase';
    } else if (['purchase', 'transfer'].includes(changedInput.value) && secondLink) {
      $('#balanceEffectInput2').value = $('#balanceEffectInput').value === 'increase' ? 'decrease' : 'increase';
    }
  }

  function closeForm() { $('#formModal').hidden = true; }

  async function deleteBy(id, kind) {
    const archive = kind !== 'transaction';
    if (!confirm(archive ? 'Lưu trữ khoản mục này? Lịch sử biến động sẽ được giữ lại.' : 'Xóa giao dịch này? Biến động số dư liên kết sẽ được đảo lại.')) return;
    try {
      if (hasCloudSession()) {
        const table = kind === 'transaction' ? 'transactions' : kind === 'asset' ? 'assets' : 'debts';
        const query = supabaseClient.from(table);
        const { error } = archive
          ? await query.update({ is_archived: true }).eq('id', id).eq('space_id', activeSpace.id)
          : await query.delete().eq('id', id).eq('space_id', activeSpace.id);
        if (error) throw error;
      }
      data = await loadSpaceData(activeSpace.id, filter);
      renderAll();
    } catch (error) {
      setCloudStatus(`Không thể ${archive ? 'lưu trữ' : 'xóa'} khoản mục: ${error.message}`, true);
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
    if ($('#balanceMovementTypeInput').value !== 'transaction') syncLinkedMovementType($('#balanceMovementTypeInput'));
    else if ($('#balanceMovementTypeInput2').value !== 'transaction') syncLinkedMovementType($('#balanceMovementTypeInput2'));
  });
  $('#linkedBalanceInput2').addEventListener('change', () => {
    $('#balanceEffectInput2').disabled = !$('#linkedBalanceInput2').value;
    if ($('#balanceMovementTypeInput').value !== 'transaction') syncLinkedMovementType($('#balanceMovementTypeInput'));
    else if ($('#balanceMovementTypeInput2').value !== 'transaction') syncLinkedMovementType($('#balanceMovementTypeInput2'));
  });
  $('#balanceMovementTypeInput').addEventListener('change', () => syncLinkedMovementType($('#balanceMovementTypeInput')));
  $('#balanceMovementTypeInput2').addEventListener('change', () => syncLinkedMovementType($('#balanceMovementTypeInput2')));
  $('#balanceEffectInput').addEventListener('change', () => {
    if (['purchase', 'transfer'].includes($('#balanceMovementTypeInput').value) && $('#linkedBalanceInput2').value) {
      $('#balanceEffectInput2').value = $('#balanceEffectInput').value === 'increase' ? 'decrease' : 'increase';
    }
  });
  $('#linkedBalanceSearch').addEventListener('input', () => void searchAccountOptions($('#linkedBalanceSearch'), $('#linkedBalanceInput'), 'Không liên kết'));
  $('#linkedBalanceSearch2').addEventListener('input', () => void searchAccountOptions($('#linkedBalanceSearch2'), $('#linkedBalanceInput2'), 'Không liên kết'));
  $('#movementAccountSearch').addEventListener('input', () => void searchAccountOptions($('#movementAccountSearch'), $('#movementAccountInput'), 'Chọn tài khoản'));
  $('#movementDestinationSearch').addEventListener('input', () => void searchAccountOptions($('#movementDestinationSearch'), $('#movementDestinationInput'), 'Chọn tài khoản'));
  $('#movementModeInput').addEventListener('change', updateMovementInputs);
  $('#financeTypeKindInput').addEventListener('change', () => {
    $('#financeTypeLiquidInput').disabled = $('#financeTypeKindInput').value === 'liability';
    if ($('#financeTypeLiquidInput').disabled) $('#financeTypeLiquidInput').checked = false;
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

  async function loadMoreAccounts(kind) {
    const isAsset = kind === 'asset';
    const cursor = isAsset ? data.assetCursor : data.debtCursor;
    const more = isAsset ? data.hasMoreAssets : data.hasMoreDebts;
    if (!activeSpace || !cursor || !more) return;
    const button = isAsset ? $('#loadMoreAssets') : $('#loadMoreDebts');
    button.disabled = true;
    try {
      const page = await fetchAccountPage(activeSpace.id, kind, cursor);
      if (isAsset) {
        data.assets.push(...page.items);
        data.hasMoreAssets = page.hasMore;
        data.assetCursor = page.cursor;
      } else {
        data.debts.push(...page.items);
        data.hasMoreDebts = page.hasMore;
        data.debtCursor = page.cursor;
      }
      renderAssets();
    } catch (error) {
      setCloudStatus(`Không thể tải thêm khoản mục: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }
  $('#loadMoreAssets').addEventListener('click', () => void loadMoreAccounts('asset'));
  $('#loadMoreDebts').addEventListener('click', () => void loadMoreAccounts('liability'));
  $('#toggleLiquidAssets').addEventListener('click', () => {
    liquidAssetsExpanded = !liquidAssetsExpanded;
    renderOverview();
  });
  $('#loadMoreLiquidAssets').addEventListener('click', async () => {
    if (!activeSpace || !data.liquidAssetCursor || !data.hasMoreLiquidAssets) return;
    const button = $('#loadMoreLiquidAssets');
    button.disabled = true;
    try {
      const page = await fetchLiquidAssetPage(activeSpace.id, data.liquidAssetCursor);
      data.liquidAssets.push(...page.items);
      data.hasMoreLiquidAssets = page.hasMore;
      data.liquidAssetCursor = page.cursor;
      renderOverview();
    } catch (error) {
      setCloudStatus(`Không thể tải thêm tài sản thanh khoản: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
  $('#loadMoreMovements').addEventListener('click', async () => {
    if (!activeSpace || !data.movementCursor || !data.hasMoreMovements) return;
    const button = $('#loadMoreMovements');
    button.disabled = true;
    try {
      const page = await fetchMovementPage(activeSpace.id, data.movementCursor);
      data.movements.push(...page.movements);
      data.hasMoreMovements = page.hasMore;
      data.movementCursor = page.cursor;
      renderAssets();
    } catch (error) {
      setCloudStatus(`Không thể tải thêm biến động: ${error.message}`, true);
    } finally {
      button.disabled = false;
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

  $('#financeTypeForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#financeTypeError').hidden = true;
    try {
      const kind = $('#financeTypeKindInput').value;
      const label = $('#financeTypeLabelInput').value.trim();
      const isLiquid = kind === 'asset' && $('#financeTypeLiquidInput').checked;
      const { data: id, error } = await supabaseClient.rpc('create_space_finance_type', {
        p_space_id: activeSpace.id, p_account_kind: kind, p_label: label, p_is_liquid: isLiquid,
      });
      if (error) throw error;
      data.financeTypes.push({ id, account_kind: kind, code: `custom-${id}`, label, is_liquid: isLiquid, is_archived: false });
      $('#financeTypeLabelInput').value = '';
      $('#financeTypeLiquidInput').checked = false;
      updateAccountTypeOptions();
      renderFinanceTypeManager();
    } catch (error) {
      $('#financeTypeError').textContent = `Không thể thêm loại tài khoản: ${error.message}`;
      $('#financeTypeError').hidden = false;
    }
  });

  document.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-kind]');
    const saveCategory = event.target.closest('[data-save-category]');
    const saveFinanceType = event.target.closest('[data-save-finance-type]');
    const transaction = event.target.closest('[data-delete-transaction]');
    const asset = event.target.closest('[data-delete-asset]');
    const debt = event.target.closest('[data-delete-debt]');
    const removeMember = event.target.closest('[data-remove-member]');
    const changeRole = event.target.closest('[data-member-role]');
    const revokeInvite = event.target.closest('[data-revoke-invite]');
    const archiveCategory = event.target.closest('[data-archive-category]');
    const archiveFinanceType = event.target.closest('[data-archive-finance-type]');
    if (edit) editItem(edit.dataset.editKind, edit.dataset.editId);
    else if (saveCategory) void (async () => {
      $('#categoryError').hidden = true;
      try {
        const category = data.categories.find((item) => item.id === saveCategory.dataset.saveCategory);
        const row = saveCategory.closest('.member-row');
        const label = row.querySelector('[data-category-label]').value.trim();
        const type = row.querySelector('[data-category-type]').value;
        const { error } = await supabaseClient.rpc('rename_transaction_category', {
          p_space_id: activeSpace.id, p_category_id: category.id, p_type: type, p_label: label,
        });
        if (error) throw error;
        category.label = label;
        category.type = type;
        updateCategories();
        renderCategoryManager();
      } catch (error) {
        $('#categoryError').textContent = `Không thể cập nhật danh mục: ${error.message}`;
        $('#categoryError').hidden = false;
      }
    })();
    else if (saveFinanceType) void (async () => {
      $('#financeTypeError').hidden = true;
      try {
        const financeType = data.financeTypes.find((item) => item.id === saveFinanceType.dataset.saveFinanceType);
        const label = saveFinanceType.closest('.member-row').querySelector('[data-finance-type-label]').value.trim();
        const { error } = await supabaseClient.rpc('rename_space_finance_type', {
          p_space_id: activeSpace.id, p_type_id: financeType.id, p_label: label,
        });
        if (error) throw error;
        financeType.label = label;
        data.assets.forEach((asset) => {
          if (asset.accountTypeId === financeType.id) asset.account_type_label = label;
        });
        data.debts.forEach((debt) => {
          if (debt.accountTypeId === financeType.id) debt.account_type_label = label;
        });
        data.liquidAssets.forEach((asset) => {
          if (asset.account_type_id === financeType.id) asset.account_type_label = label;
        });
        updateAccountTypeOptions();
        renderFinanceTypeManager();
        renderAll();
      } catch (error) {
        $('#financeTypeError').textContent = `Không thể cập nhật loại tài khoản: ${error.message}`;
        $('#financeTypeError').hidden = false;
      }
    })();
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
    else if (archiveFinanceType) void (async () => {
      $('#financeTypeError').hidden = true;
      try {
        const { error } = await supabaseClient.rpc('archive_space_finance_type', {
          p_space_id: activeSpace.id, p_type_id: archiveFinanceType.dataset.archiveFinanceType,
        });
        if (error) throw error;
        const financeType = data.financeTypes.find((item) => item.id === archiveFinanceType.dataset.archiveFinanceType);
        if (financeType) financeType.is_archived = true;
        updateAccountTypeOptions();
        renderFinanceTypeManager();
      } catch (error) {
        $('#financeTypeError').textContent = `Không thể lưu trữ loại tài khoản: ${error.message}`;
        $('#financeTypeError').hidden = false;
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
  document.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-finance-type-liquid]');
    if (!toggle) return;
    void (async () => {
      $('#financeTypeError').hidden = true;
      let saved = false;
      try {
        const { error } = await supabaseClient.rpc('set_space_finance_type_liquidity', {
          p_space_id: activeSpace.id, p_type_id: toggle.dataset.financeTypeLiquid, p_is_liquid: toggle.checked,
        });
        if (error) throw error;
        saved = true;
        const financeType = data.financeTypes.find((item) => item.id === toggle.dataset.financeTypeLiquid);
        if (financeType) financeType.is_liquid = toggle.checked;
        const period = reportPeriod();
        const [summary, liquidAssets] = await Promise.all([
          supabaseClient.rpc('get_space_financial_summary_v2', {
            p_space_id: activeSpace.id, p_month_start: period.start, p_month_end: period.end,
          }),
          fetchLiquidAssetPage(activeSpace.id, null),
        ]);
        if (summary.error) throw summary.error;
        const totals = financialObject(summary.data, 'liquidity_summary');
        data.summary.cash_value = optionalFinancialNumber(
          totals.cash_value ?? totals.liquid_assets_value,
          'cash_value',
          0,
        );
        data.summary.liquid_assets_value = optionalFinancialNumber(
          totals.liquid_assets_value,
          'liquid_assets_value',
          data.summary.cash_value,
        );
        data.liquidAssets = liquidAssets.items;
        data.hasMoreLiquidAssets = liquidAssets.hasMore;
        data.liquidAssetCursor = liquidAssets.cursor;
        data.assets.forEach((asset) => {
          asset.is_liquid = data.financeTypes.find((type) => type.id === asset.accountTypeId)?.is_liquid || false;
        });
        renderAll();
      } catch (error) {
        if (saved) {
          setCloudStatus(`Đã lưu thay đổi thanh khoản nhưng không thể làm mới tổng quan: ${error.message}`, true);
        } else {
          toggle.checked = !toggle.checked;
          $('#financeTypeError').textContent = `Không thể thay đổi tính thanh khoản: ${error.message}`;
          $('#financeTypeError').hidden = false;
        }
      }
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
        const linkedValue2 = $('#linkedBalanceInput2').value;
        if (linkedValue && linkedValue === linkedValue2) throw new Error('Hai liên kết phải trỏ đến các khoản mục khác nhau.');
        item = {
          id:editingItem?.id || makeId(), type:transactionType, amount, category:$('#categoryInput').value,
          note:$('#noteInput').value.trim(), date:editingItem?.date || new Date().toISOString(),
          linkedAssetId:linkedValue.startsWith('asset:') ? linkedValue.slice(6) : null,
          linkedDebtId:linkedValue.startsWith('debt:') ? linkedValue.slice(5) : null,
          balanceEffect:linkedValue ? $('#balanceEffectInput').value : null,
          linkedAssetId2:linkedValue2.startsWith('asset:') ? linkedValue2.slice(6) : null,
          linkedDebtId2:linkedValue2.startsWith('debt:') ? linkedValue2.slice(5) : null,
          balanceEffect2:linkedValue2 ? $('#balanceEffectInput2').value : null,
          balanceMovementType:linkedValue ? $('#balanceMovementTypeInput').value : null,
          balanceMovementType2:linkedValue2 ? $('#balanceMovementTypeInput2').value : null,
        };
        table = 'transactions';
      } else if (formMode === 'asset') {
        const name = $('#nameInput').value.trim();
        if (!name) { $('#formError').textContent = 'Vui lòng nhập tên tài sản.'; $('#formError').hidden = false; return; }
        const accountType = data.financeTypes.find((type) => type.id === $('#assetKindInput').value);
        if (!accountType) throw new Error('Chọn một loại tài sản đang hoạt động.');
        item = { id:editingItem?.id || makeId(), name, kind:accountType.code, accountTypeId:accountType.id, value:amount };
        table = 'assets';
      } else if (formMode === 'debt') {
        const name = $('#debtNameInput').value.trim();
        if (!name) { $('#formError').textContent = 'Vui lòng nhập tên khoản nợ.'; $('#formError').hidden = false; return; }
        const accountType = data.financeTypes.find((type) => type.id === $('#debtKindInput').value);
        if (!accountType) throw new Error('Chọn một loại khoản phải trả đang hoạt động.');
        const dueDate = $('#dueDateInput').value;
        item = { id:editingItem?.id || makeId(), name, kind:accountType.code, accountTypeId:accountType.id, amount, ...(dueDate ? { dueDate } : {}) };
        table = 'debts';
      }
      if (hasCloudSession()) {
        if (formMode === 'movement') {
          const movementMode = $('#movementModeInput').value;
          const accountValue = $('#movementAccountInput').value;
          if (!accountValue) throw new Error('Chọn tài khoản cần cập nhật.');
          const [sourceKind, sourceId] = accountValue.split(':');
          const common = { p_space_id:activeSpace.id, p_amount:amount, p_note:$('#movementNoteInput').value.trim(), p_occurred_at:new Date().toISOString() };
          if (movementMode === 'adjustment') {
            const { error } = await supabaseClient.rpc('record_account_movement', {
              ...common, p_account_kind:sourceKind, p_account_id:sourceId, p_direction:$('#movementDirectionInput').value,
            });
            if (error) throw error;
          } else {
            const destinationValue = $('#movementDestinationInput').value;
            if (!destinationValue) throw new Error('Chọn tài khoản nhận hoặc đối ứng.');
            const [destinationKind, destinationId] = destinationValue.split(':');
            const { error } = await supabaseClient.rpc('record_account_transfer', {
              ...common, p_movement_type:movementMode, p_source_kind:sourceKind, p_source_id:sourceId,
              p_destination_kind:destinationKind, p_destination_id:destinationId,
            });
            if (error) throw error;
          }
        } else {
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
        format:'dong-tien-backup-v2',
        exportedAt:new Date().toISOString(),
        transactions:await fetchAllTransactions(activeSpace.id),
        assets:await fetchAllAccounts(activeSpace.id, 'asset', true),
        debts:await fetchAllAccounts(activeSpace.id, 'liability', true),
        movements:await fetchAllMovements(activeSpace.id),
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
      if (!['dong-tien-backup-v1', 'dong-tien-backup-v2'].includes(parsed.format)) throw new Error('Tệp không đúng định dạng sao lưu của Dòng Tiền.');
      const restored = { transactions: parsed.transactions, assets: parsed.assets, debts: parsed.debts, movements: parsed.movements || [] };
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
      if (!await refreshSpaces(spaceId)) return;
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
      if (!await refreshSpaces(spaces.find((space) => space.kind === 'personal' && space.id !== deletedId)?.id)) return;
      setCloudStatus('Đã xóa không gian gia đình.');
    } catch (error) { $('#familyError').textContent = `Không thể xóa không gian: ${error.message}`; $('#familyError').hidden = false; }
  });

  $('#authGateRetry').addEventListener('click', () => { void checkAuthSession(); });

  let currentPeriod = reportPeriod();

  $('#prevMonthBtn').addEventListener('click', () => {
    const prev = new Date(currentPeriod.start);
    prev.setMonth(prev.getMonth() - 1);
    currentPeriod = { start: prev.toISOString(), end: new Date(prev.getFullYear(), prev.getMonth() + 1, 1).toISOString(), label: prev.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' }) };
    void loadSpaceData(activeSpace.id, filter);
  });

  $('#nextMonthBtn').addEventListener('click', () => {
    const next = new Date(currentPeriod.end);
    next.setMonth(next.getMonth() + 1);
    currentPeriod = { start: currentPeriod.end, end: new Date(next.getFullYear(), next.getMonth() + 1, 1).toISOString(), label: next.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' }) };
    void loadSpaceData(activeSpace.id, filter);
  });

  updateCategories();
  renderAll();
  renderConnection();
  initializeSupabase();
})();

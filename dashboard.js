/* =========================================================================
   LEDGER — Dashboard logic
   ========================================================================= */

// Color palette for categories (refined editorial tones)
const PALETTE = [
  '#1f4d3f', // emerald
  '#8a2a23', // crimson
  '#b8821a', // gold
  '#3d6480', // dusty blue
  '#6b4a7a', // mauve
  '#5a6b3d', // moss
  '#a85a3a', // burnt orange
  '#3a5e6b', // teal
  '#6b3d5a', // plum
  '#7a6b3d', // olive
];
const colorFor = (i) => PALETTE[i % PALETTE.length];

let donutChart = null;
let barChart   = null;
let state      = null; // last summary fetched

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const cur = () => state?.currency || '€';

const todayISO = () => new Date().toISOString().slice(0, 10);

// ============================================================
// API helpers
// ============================================================
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = 'Request failed';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const fetchSummary  = () => api('/api/summary');
const setCurrency   = (symbol) => api('/api/currency',   { method: 'POST', body: JSON.stringify({ symbol }) });
const setSavings    = (amount) => api('/api/savings',    { method: 'POST', body: JSON.stringify({ amount }) });
const addCategory   = (name, budget) => api('/api/categories', { method: 'POST', body: JSON.stringify({ name, budget }) });
const updateCategory= (id, patch) => api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
const deleteCategory= (id) => api(`/api/categories/${id}`, { method: 'DELETE' });
const addTransaction= (payload) => api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
const deleteTransaction = (id) => api(`/api/transactions/${id}`, { method: 'DELETE' });
const addGift       = (payload) => api('/api/gifts', { method: 'POST', body: JSON.stringify(payload) });
const deleteGift    = (id) => api(`/api/gifts/${id}`, { method: 'DELETE' });
const addGiftExpense    = (payload) => api('/api/gift-expenses', { method: 'POST', body: JSON.stringify(payload) });
const deleteGiftExpense = (id) => api(`/api/gift-expenses/${id}`, { method: 'DELETE' });

// ============================================================
// Render
// ============================================================
function render(s) {
  state = s;

  // Currency picker
  $('#currency-select').value = s.currency;

  // Hero
  const total = s.total_money;
  const [whole, dec] = fmt(total).split('.');
  $('#hero-currency').textContent = s.currency;
  $('#hero-total').textContent    = whole;
  $('#hero-decimals').textContent = '.' + (dec || '00');

  $('#stat-living').textContent  = `${s.currency}${fmt(s.living_remaining)}`;
  $('#stat-gifted').textContent  = `${s.currency}${fmt(s.gifted_total)}`;
  $('#stat-savings').textContent = `${s.currency}${fmt(s.savings)}`;

  // Living budget meta
  $('#living-actual').textContent       = `${s.currency}${fmt(s.living_actual_total)}`;
  $('#living-budget-total').textContent = `${s.currency}${fmt(s.living_budget_total)}`;

  // Gifted money header (set early so it's never blocked by other render errors)
  $('#gifted-total').textContent   = `${s.currency}${fmt(s.gifted_total)}`;
  $('#gifts-received').textContent = `${s.currency}${fmt(s.gifts_received)}`;
  $('#gifts-spent').textContent    = `${s.currency}${fmt(s.gifts_spent)}`;

  // Savings input
  $('#savings-amount').value     = s.savings;
  $('#savings-currency').textContent = s.currency;

  // The functions below are isolated so a failure in one (e.g. Chart.js
  // CDN hiccup) doesn't prevent the rest of the dashboard from rendering.
  safe(renderCategories, s);
  safe(renderCharts, s);
  safe(renderTransactions, s);
  safe(renderGifts, s);
}

function safe(fn, ...args) {
  try { fn(...args); }
  catch (err) { console.error(`${fn.name} failed:`, err); }
}

// --- Categories -----------------------------------------------------------
function renderCategories(s) {
  const tbody = $('#cat-tbody');
  tbody.innerHTML = '';

  s.categories.forEach((c, i) => {
    const color = colorFor(i);
    const pct = c.budget > 0 ? Math.min(100, (c.actual / c.budget) * 100) : 0;
    const overBy = c.actual - c.budget;
    let barClass = '';
    if (overBy > 0) barClass = 'over';
    else if (pct > 80) barClass = 'warn';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <span class="cat-name">
          <span class="cat-swatch" style="background:${color}"></span>
          <input class="cell-edit" data-id="${c.id}" data-field="name" value="${escapeHtml(c.name)}" />
        </span>
      </td>
      <td class="num">
        <input class="cell-edit" data-id="${c.id}" data-field="budget" type="number" min="0" step="0.01" value="${c.budget}" style="text-align:right" />
      </td>
      <td class="num">${cur()}${fmt(c.actual)}</td>
      <td class="num" style="color:${overBy > 0 ? 'var(--crimson)' : 'inherit'}">${cur()}${fmt(c.difference)}</td>
      <td class="num"><span class="bar ${barClass}"><span style="width:${pct}%"></span></span></td>
      <td class="num"><button class="cell-del" data-del-cat="${c.id}" title="Delete category">×</button></td>
    `;
    tbody.appendChild(tr);
  });

  $('#foot-budget').textContent    = `${cur()}${fmt(s.living_budget_total)}`;
  $('#foot-actual').textContent    = `${cur()}${fmt(s.living_actual_total)}`;
  $('#foot-remaining').textContent = `${cur()}${fmt(s.living_remaining)}`;

  // Wire up category edits
  $$('#cat-tbody .cell-edit').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const field = e.target.dataset.field;
      const value = field === 'budget' ? parseFloat(e.target.value) || 0 : e.target.value;
      try {
        await updateCategory(id, { [field]: value });
        const fresh = await fetchSummary();
        render(fresh);
      } catch (err) { alert(err.message); }
    });
  });
  $$('#cat-tbody [data-del-cat]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this category and all its transactions?')) return;
      try {
        await deleteCategory(btn.dataset.delCat);
        const fresh = await fetchSummary();
        render(fresh);
      } catch (err) { alert(err.message); }
    });
  });

  // Update the txn-form category dropdown
  const sel = $('#txn-category');
  sel.innerHTML = s.categories.length === 0
    ? '<option value="">(no categories — add one)</option>'
    : s.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

// --- Charts ---------------------------------------------------------------
function renderCharts(s) {
  const labels = s.categories.map(c => c.name);
  const actuals = s.categories.map(c => c.actual);
  const budgets = s.categories.map(c => c.budget);
  const colors = s.categories.map((_, i) => colorFor(i));

  // Donut
  const donutCtx = $('#donut-chart').getContext('2d');
  const hasActual = actuals.some(v => v > 0);
  const donutData = hasActual ? actuals : [1];
  const donutLabels = hasActual ? labels : ['No spending yet'];
  const donutColors = hasActual ? colors : ['#e7e0cf'];

  if (donutChart) donutChart.destroy();
  donutChart = new Chart(donutCtx, {
    type: 'doughnut',
    data: {
      labels: donutLabels,
      datasets: [{
        data: donutData,
        backgroundColor: donutColors,
        borderColor: '#f9f5ec',
        borderWidth: 3,
        hoverOffset: 10,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: hasActual,
          backgroundColor: '#1a1a1a',
          padding: 10,
          titleFont: { family: 'DM Sans', size: 12, weight: '500' },
          bodyFont: { family: 'DM Sans', size: 12 },
          callbacks: {
            label: (ctx) => `${ctx.label}: ${cur()}${fmt(ctx.parsed)}`,
          },
        },
      },
    },
  });

  const pct = s.living_budget_total > 0
    ? Math.round((s.living_actual_total / s.living_budget_total) * 100)
    : 0;
  $('#donut-pct').textContent = `${pct}%`;

  // Donut legend
  const legend = $('#donut-legend');
  if (hasActual) {
    legend.innerHTML = labels.map((l, i) => `
      <span class="legend-item">
        <span class="legend-swatch" style="background:${colors[i]}"></span>${escapeHtml(l)}
      </span>
    `).join('');
  } else {
    legend.innerHTML = '<span class="legend-item" style="color:var(--ink-faint)">Add transactions to see the breakdown</span>';
  }

  // Bar chart
  const barCtx = $('#bar-chart').getContext('2d');
  if (barChart) barChart.destroy();
  barChart = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Budget',
          data: budgets,
          backgroundColor: 'rgba(31,77,63,0.18)',
          borderColor: 'rgba(31,77,63,0.5)',
          borderWidth: 1,
          borderRadius: 3,
        },
        {
          label: 'Actual',
          data: actuals,
          backgroundColor: '#1f4d3f',
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#6b665d', font: { family: 'DM Sans', size: 11 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#e7e0cf' },
          ticks: {
            color: '#6b665d',
            font: { family: 'DM Sans', size: 11 },
            callback: (v) => `${cur()}${v}`,
          },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#3d3a36',
            font: { family: 'DM Sans', size: 12 },
            boxWidth: 10, boxHeight: 10, usePointStyle: true,
          },
        },
        tooltip: {
          backgroundColor: '#1a1a1a',
          padding: 10,
          titleFont: { family: 'DM Sans', size: 12 },
          bodyFont: { family: 'DM Sans', size: 12 },
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${cur()}${fmt(ctx.parsed.y)}`,
          },
        },
      },
    },
  });
  $('#bar-chart').parentElement.style.height = '280px';
}

// --- Transactions ---------------------------------------------------------
function renderTransactions(s) {
  const ul = $('#txn-list');
  if (!s.transactions.length) {
    ul.innerHTML = '<li style="color:var(--ink-faint);grid-template-columns:1fr">No transactions yet — log your first one above.</li>';
    return;
  }
  ul.innerHTML = s.transactions.map(t => `
    <li>
      <span class="pill">${escapeHtml(t.category)}</span>
      <span class="desc">${escapeHtml(t.description) || '<em style="color:var(--ink-faint)">untitled</em>'}</span>
      <span class="amt">${cur()}${fmt(t.amount)}</span>
      <span class="when">${formatDate(t.date)}</span>
      <button class="cell-del" data-del-txn="${t.id}" title="Delete">×</button>
    </li>
  `).join('');
  $$('#txn-list [data-del-txn]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await deleteTransaction(btn.dataset.delTxn);
        const fresh = await fetchSummary();
        render(fresh);
      } catch (err) { alert(err.message); }
    });
  });
}

// --- Gifts (combined ledger: deposits + spending) -------------------------
function renderGifts(s) {
  const ul = $('#gift-list');
  const ledger = s.gift_ledger || [];
  if (!ledger.length) {
    ul.innerHTML = '<li style="color:var(--ink-faint);grid-template-columns:1fr">No gift activity yet — add a gift above to start.</li>';
    return;
  }
  ul.innerHTML = ledger.map(entry => {
    const isGift = entry.kind === 'gift';
    const sign   = isGift ? '+' : '−';
    const cls    = isGift ? 'in' : 'out';
    const label  = isGift ? 'Gift' : 'Spent';
    const delAttr = isGift ? `data-del-gift="${entry.id}"` : `data-del-gift-exp="${entry.id}"`;
    return `
      <li>
        <span class="pill ${cls}">${label}</span>
        <span class="desc">${escapeHtml(entry.description) || '<em style="color:var(--ink-faint)">untitled</em>'}</span>
        <span class="amt ${cls}">${sign}${cur()}${fmt(entry.amount)}</span>
        <span class="when">${formatDate(entry.date)}</span>
        <button class="cell-del" ${delAttr} title="Delete">×</button>
      </li>
    `;
  }).join('');
  $$('#gift-list [data-del-gift]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await deleteGift(btn.dataset.delGift);
        const fresh = await fetchSummary();
        render(fresh);
      } catch (err) { alert(err.message); }
    });
  });
  $$('#gift-list [data-del-gift-exp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await deleteGiftExpense(btn.dataset.delGiftExp);
        const fresh = await fetchSummary();
        render(fresh);
      } catch (err) { alert(err.message); }
    });
  });
}

// ============================================================
// Utility
// ============================================================
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================
// Event wiring
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Currency picker
  $('#currency-select').addEventListener('change', async (e) => {
    try {
      await setCurrency(e.target.value);
      const fresh = await fetchSummary();
      render(fresh);
    } catch (err) { alert(err.message); }
  });

  // Add category modal
  const modal = $('#cat-modal');
  $('#add-category-btn').addEventListener('click', () => {
    modal.hidden = false;
    setTimeout(() => $('#cat-name').focus(), 50);
  });
  $$('[data-close-modal]').forEach(el => el.addEventListener('click', () => {
    modal.hidden = true;
  }));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  $('#cat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#cat-name').value.trim();
    const budget = parseFloat($('#cat-budget').value) || 0;
    if (!name) return;
    try {
      await addCategory(name, budget);
      $('#cat-name').value = '';
      $('#cat-budget').value = '';
      modal.hidden = true;
      const fresh = await fetchSummary();
      render(fresh);
    } catch (err) { alert(err.message); }
  });

  // Transaction form
  $('#txn-date').value = todayISO();
  $('#txn-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const category_id = $('#txn-category').value;
    const amount = parseFloat($('#txn-amount').value);
    const description = $('#txn-description').value;
    const date = $('#txn-date').value || todayISO();
    if (!category_id || isNaN(amount)) return;
    try {
      await addTransaction({ category_id, amount, description, date });
      $('#txn-amount').value = '';
      $('#txn-description').value = '';
      $('#txn-date').value = todayISO();
      const fresh = await fetchSummary();
      render(fresh);
    } catch (err) { alert(err.message); }
  });

  // Gift form
  $('#gift-date').value = todayISO();
  $('#gift-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseFloat($('#gift-amount').value);
    const description = $('#gift-description').value;
    const date = $('#gift-date').value || todayISO();
    if (isNaN(amount)) return;
    try {
      await addGift({ amount, description, date });
      $('#gift-amount').value = '';
      $('#gift-description').value = '';
      $('#gift-date').value = todayISO();
      const fresh = await fetchSummary();
      render(fresh);
    } catch (err) { alert(err.message); }
  });

  // Gift expense form (spend gifted money)
  $('#gift-expense-date').value = todayISO();
  $('#gift-expense-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseFloat($('#gift-expense-amount').value);
    const description = $('#gift-expense-description').value;
    const date = $('#gift-expense-date').value || todayISO();
    if (isNaN(amount) || amount <= 0) return;
    try {
      await addGiftExpense({ amount, description, date });
      $('#gift-expense-amount').value = '';
      $('#gift-expense-description').value = '';
      $('#gift-expense-date').value = todayISO();
      const fresh = await fetchSummary();
      render(fresh);
    } catch (err) { alert(err.message); }
  });

  // Savings form
  $('#savings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseFloat($('#savings-amount').value) || 0;
    try {
      await setSavings(amount);
      const fresh = await fetchSummary();
      render(fresh);
    } catch (err) { alert(err.message); }
  });

  // Initial load
  try {
    const s = await fetchSummary();
    render(s);
  } catch (err) {
    console.error(err);
    alert('Could not load dashboard data.');
  }
});
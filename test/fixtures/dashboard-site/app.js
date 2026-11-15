const routes = { '/overview': 'Overview', '/orders': 'Orders', '/customers': 'Customers', '/reports': 'Reports', '/settings': 'Settings' };
const orders = [
  { id: 'A-1041', customer: 'Dana Whitfield', status: 'Paid', total: 240 },
  { id: 'A-1040', customer: 'Luis Ortega', status: 'Shipped', total: 89 },
  { id: 'A-1039', customer: 'Mei Tanaka', status: 'Pending', total: 412 },
];
function render() {
  document.querySelector('#orders').innerHTML = orders
    .map((o) => `<tr><td>${o.id}</td><td>${o.customer}</td><td>${o.status}</td><td>$${o.total}</td></tr>`)
    .join('');
  const pts = [20, 40, 35, 60, 55, 80, 95].map((v, i) => `${i * 60 + 10},${110 - v}`).join(' ');
  document.querySelector('#chart').innerHTML = `<polyline fill="none" stroke="#38bdf8" stroke-width="3" points="${pts}"/>`;
}
window.addEventListener('hashchange', () => {
  document.querySelector('h1').textContent = routes[location.hash.slice(1)] ?? 'Overview';
});
document.querySelector('#new-order').addEventListener('click', () => document.querySelector('#order-dialog').showModal());
document.querySelector('#order-dialog').addEventListener('close', (e) => {
  if (e.target.returnValue !== 'save') return;
  const f = new FormData(e.target.querySelector('form'));
  orders.unshift({ id: 'A-' + (1042 + orders.length), customer: f.get('customer'), status: f.get('status'), total: Number(f.get('total')) });
  render();
});
fetch('/api/orders?limit=10').catch(() => {});
render();

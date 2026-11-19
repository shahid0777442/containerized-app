async function load() {
  try {
    const res = await fetch('/api/visits'); // nginx isay backend:3000 par proxy karta hai
    const data = await res.json();
    document.getElementById('db').textContent = data.db_total_visits;
    document.getElementById('redis').textContent = data.redis_api_hits;
    document.getElementById('err').textContent = '';
  } catch (e) {
    document.getElementById('err').textContent = 'API se connect nahi ho saka';
  }
}
document.getElementById('btn').addEventListener('click', load);
load();

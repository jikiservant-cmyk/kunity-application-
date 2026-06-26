async function run() {
  const res = await fetch("http://localhost:3000/api/test-tenants-col");
  const json = await res.json();
  console.log(JSON.stringify(json));
}
run();

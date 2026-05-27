// vuln_test.js — intentionally vulnerable fixture for BackBrain pipeline testing

// 1. Hardcoded API secret
const API_SECRET = "sk-prod-a3f8c2d91b4e7f0a6c5e2d8b1f4a7e0c";

// 2. SQL injection — user input concatenated directly into query
function getUserById(db, userId) {
  const query = "SELECT * FROM users WHERE id = '" + userId + "'";
  return db.query(query);
}

// 3. Unhandled promise rejection — no .catch() or try/await
function fetchUserData(url) {
  fetch(url).then(res => res.json()).then(data => {
    processData(data);
  });
}

// 4. Missing import being used (processData is never defined/imported)
function main() {
  const result = getUserById(db, userInput);
  fetchUserData("https://api.example.com/users");
  processData(result);  // processData is not defined anywhere in this file
}

main();

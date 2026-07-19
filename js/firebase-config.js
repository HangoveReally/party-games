// Переиспользуем Firebase-проект «Шпиона» (Realtime Database, europe-west1).
// Веб-ключи Firebase не секретны — доступ ограничивается правилами базы.
// Хаб пати-игр живёт в отдельном узле /party, чтобы не пересекаться с /rooms «Шпиона».
// ВАЖНО: в правилах БД нужно разрешить чтение/запись для /party (см. README-инструкцию).

const firebaseConfig = {
  apiKey: "AIzaSyB2xGyhD7O5Jru3WBFUptGU5jqI7D_DC1o",
  authDomain: "test-136d3.firebaseapp.com",
  databaseURL: "https://test-136d3-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "test-136d3",
  storageBucket: "test-136d3.firebasestorage.app",
  messagingSenderId: "929156271000",
  appId: "1:929156271000:web:087fb9840d71ef771f39ed",
  measurementId: "G-RLYQ70R3T7",
};

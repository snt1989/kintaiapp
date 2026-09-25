// API通信・認証状態の共通ヘルパー
const Api = (() => {
  const TOKEN_KEY = 'sanoh_attendance_token';
  const EMPLOYEE_KEY = 'sanoh_attendance_employee';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getEmployee() {
    const raw = localStorage.getItem(EMPLOYEE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function setSession(token, employee) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(employee));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMPLOYEE_KEY);
  }

  async function request(path, options = {}) {
    const token = getToken();
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      options.headers || {}
    );
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`/api${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401) {
      clearSession();
      if (!location.pathname.endsWith('/index.html') && location.pathname !== '/') {
        location.href = '/index.html';
      }
      throw new Error('認証切れです。再度ログインしてください。');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error || `エラーが発生しました (${res.status})`;
      throw new Error(data.detail ? `${message}(詳細: ${data.detail})` : message);
    }
    return data;
  }

  function requireLogin() {
    if (!getToken()) {
      location.href = '/index.html';
    }
  }

  function requireAdmin() {
    const emp = getEmployee();
    if (!getToken() || !emp || emp.role !== 'admin') {
      location.href = '/index.html';
    }
  }

  return { request, getToken, getEmployee, setSession, clearSession, requireLogin, requireAdmin };
})();

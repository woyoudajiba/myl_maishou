(function (root) {
  function platformLoginForm({ platform, credential = null }) {
    const hosts = { wsy: ['www.wsy.com','wsy.com','cs.wsy.com'], zwd: ['stu.17zwd.com','www.17zwd.com'], qcc: ['www.17qcc.com'], e3hui: ['www.e3hui.com','www.e3hui.cn'] };
    const allowed = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && (hosts[platform] || []).includes(url.hostname);
    if (!allowed(new URL(location.href))) return { state: 'manual', reason: '请在平台 HTTPS 官方登录页完成登录' };
    const visible = node => !!(node && !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    if (!passwords.length) return { state: /login|passport|signin/i.test(location.pathname) ? 'manual' : 'not_required', reason: '当前页面未显示账号密码登录表单' };
    if (passwords.length !== 1) return { state: 'manual', reason: '登录表单不唯一，请手动登录' };
    const password = passwords[0], form = password.closest('form');
    const scope = form || password.closest('[class*="login"], [id*="login"]');
    if (!scope) return { state: 'manual', reason: '无法确认登录表单范围，请手动登录' };
    const captcha = [...scope.querySelectorAll('input,iframe,[class*="captcha"],[class*="geetest"],[class*="slider"]')].find(node => visible(node) && /captcha|verify|verification|验证码|滑块|短信|otp|geetest|slider/i.test([node.name,node.id,node.className,node.getAttribute('placeholder'),node.getAttribute('title')].join(' ')));
    if (captcha) return { state: 'manual', reason: '平台需要验证码或安全验证，请手动完成' };
    const users = [...scope.querySelectorAll('input')].filter(node => visible(node) && ['text','tel','email'].includes(node.type) && !/captcha|verify|验证码|短信|otp/i.test([node.name,node.id,node.placeholder].join(' ')));
    const preferred = users.filter(node => /user|account|phone|mobile|login|账号|手机|会员/i.test([node.name,node.id,node.placeholder,node.autocomplete].join(' ')));
    const user = preferred.length === 1 ? preferred[0] : users.length === 1 ? users[0] : null;
    if (!user) return { state: 'manual', reason: '无法唯一确认账号输入框，请手动登录' };
    const buttons = [...scope.querySelectorAll('button,input[type="submit"],a,[role="button"]')].filter(node => visible(node) && /^(登\s*录|立即登录|安全登录|sign\s*in|log\s*in)$/i.test((node.innerText || node.value || '').trim()));
    if (buttons.length !== 1) return { state: 'manual', reason: '无法唯一确认登录按钮，请手动登录' };
    const action = new URL(buttons[0].getAttribute('formaction') || form?.getAttribute('action') || location.href, location.href);
    if (!allowed(action)) return { state: 'manual', reason: '登录提交地址不在该平台安全范围，请手动登录' };
    if (form && (buttons[0].getAttribute('formmethod') || form.method).toLowerCase() !== 'post') return { state: 'manual', reason: '登录表单不是 POST 提交，请手动登录' };
    if (!credential) return { state: 'ready' };
    if (!credential.username || !credential.password) return { state: 'manual', reason: '平台账号尚未配置' };
    const set = (node, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
    set(user, credential.username); set(password, credential.password);
    buttons[0].click();
    return { state: 'submitted' };
  }
  const api = { platformLoginForm };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FindPlatformLogin = api;
})(globalThis);

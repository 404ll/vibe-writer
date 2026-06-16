/** 开发环境走 Vite 代理，避免 localhost / 127.0.0.1 跨域差异 */
export const API_BASE = import.meta.env.DEV ? '/api' : 'http://localhost:8000'

# DeepDiver Build 认证系统

> 取自 https://cn.deepdiver.app/ 前端源码逆向分析

---

## 一句话核心

**没有 cookie 认证。使用 JWT Bearer Token 认证，token 存 localStorage。**

---

## 认证流程

```
登录页 (email + password)
      │
      ▼
POST /api/users/login  ───→  服务端验证
      │                         │
      │                    ┌────┴────┐
      │                    │ 成功     │ 失败
      │                    └────┬────┘
      │                         │
      │  返回 { access_token, user }
      │                         │
      ▼                         ▼
  localStorage.setItem('deepdiver-user-token', access_token)
  localStorage.setItem('deepdiver-user-data', JSON.stringify(user))
```

---

## 接口清单

### 1. 登录

```
POST /api/users/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your_password"
}
```

**成功响应 (200):**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "c3a04974-3c2f-487b-b3a3-a0504fc9b44f",
    "email": "user@example.com",
    "display_name": "陈恩泽 30011421",
    "is_active": true,
    "is_verified": true,
    "is_admin": false,
    "created_at": "2026-07-10T07:25:44.436375Z",
    "mobile_onboarding_completed_at": null
  }
}
```

**失败响应:** `{ "detail": "错误信息" }`（HTTP 状态码非 200）

### 2. 注册（需申请权限）

```
POST /api/users/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your_password",
  "display_name": "昵称",
  "reason": "申请理由"
}
```

### 3. 获取当前用户信息

```
GET /api/users/me
Authorization: Bearer <token>
```

**响应:**

```json
{
  "id": "c3a04974-...",
  "email": "chenenze422@gmail.com",
  "display_name": "陈恩泽 30011421",
  "is_active": true,
  "is_verified": true,
  "is_admin": false,
  "created_at": "2026-07-10T07:25:44.436375Z",
  "mobile_onboarding_completed_at": null
}
```

### 4. 获取用户 API Key 列表

```
GET /api/users/me/api-keys
Authorization: Bearer <token>
```

### 5. 添加 API Key

```
POST /api/users/me/api-keys
Authorization: Bearer <token>
Content-Type: application/json

{
  "api_key": "sk-xxx",
  "name": "my-key",
  "provider": "openai"
}
```

### 6. 删除 API Key

```
DELETE /api/users/me/api-keys/{id}
Authorization: Bearer <token>
```

### 7. 退出登录

**不调用后端 API**，仅清除前端 localStorage：

```js
localStorage.removeItem('deepdiver-user-token')
localStorage.removeItem('deepdiver-user-data')
```

---

## JWT Token 详情

```
KEY:      deepdiver-user-token (localStorage)
VALUE:    JWT (eyJxxx.eyJxxx.xxx)
```

**Payload 结构:**

| 字段 | 说明 |
|------|------|
| `sub` | 用户 UUID |
| `email` | 用户邮箱 |
| `exp` | 过期时间（Unix 时间戳） |
| `iat` | 签发时间（Unix 时间戳） |

**有效期:** 24 小时

---

## 后续接口认证方式

**所有需要登录的请求都统一通过以下方式认证：**

```
Authorization: Bearer <access_token>
Content-Type: application/json
```

前端从 localStorage 取出 `deepdiver-user-token`，设置到每个请求的 header 中。这是前端 `authedFetch` 的完整逻辑：

```js
function getAuthHeaders() {
  const token = localStorage.getItem('deepdiver-user-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function authedFetch(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      'Content-Type': 'application/json',
      ...options?.headers
    }
  });
  if (!response.ok) throw new Error(await extractError(response));
  return response.json();
}
```

> **关于 Cookie:** 唯一存在的 cookie 是 `cf_clearance`（Cloudflare 反爬验证），与用户认证无关。

---

## 常见问题

### Q: 能否用 cookie 替代 Bearer Token?
不能。服务端没有实现 cookie/session 认证方式，只认 `Authorization: Bearer` header。

### Q: Token 过期后怎么办?
前端请求 `/api/users/me` 返回 401 → 自动调用 `logout()` 清空本地存储 → 跳转登录页。**没有 refresh_token 机制**，过期后只能重新登录。

### Q: localStorage key 名称?
- `deepdiver-user-token` — JWT token
- `deepdiver-user-data` — 用户基本信息（JSON）

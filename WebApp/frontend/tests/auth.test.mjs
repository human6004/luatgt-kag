import assert from "node:assert/strict"
import { homeFor, canAccessAdminPage } from "../src/auth-policy.ts"
assert.equal(homeFor("user"), "/chat")
assert.equal(homeFor("admin"), "/admin/dashboard")
for (const role of ['admin', 'police']) assert.equal(canAccessAdminPage(role, '/admin/question-bank-settings'), true)
assert.equal(canAccessAdminPage('user', '/admin/question-bank-settings'), false)
console.log("Role routing checks passed")

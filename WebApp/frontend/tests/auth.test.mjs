import assert from "node:assert/strict"
import { canAccessAdminPage, homeFor } from "../src/auth-policy.ts"
assert.equal(homeFor("user"), "/chat")
assert.equal(homeFor("admin"), "/admin/dashboard")
assert.equal(homeFor("police"), "/admin/content")
assert.equal(canAccessAdminPage("police", "/admin/content"), true)
assert.equal(canAccessAdminPage("police", "/admin/questions"), true)
assert.equal(canAccessAdminPage("police", "/admin/users"), true)
assert.equal(canAccessAdminPage("police", "/admin/dashboard"), false)
assert.equal(canAccessAdminPage("police", "/admin/chatbot"), false)
assert.equal(canAccessAdminPage("police", "/admin/infrastructure"), false)
console.log("Role routing checks passed")

# Frontend LuậtGT

React/TypeScript/Vite/Tailwind; gọi API Spring Boot. Cài sản phẩm: [INSTALL](../../docs/INSTALL.md). Hướng dẫn này dành cho phát triển; tuân thủ [rule.md](../rule.md).

## Phát triển và kiểm thử

**Bước 1 — Dependencies:** dùng Node 24, pnpm 10.11.0 như [Dockerfile](../../docker/frontend/Dockerfile). Trên host mới, cài Node 24 (kèm npm), rồi cài pnpm đúng pin trước dev/test:

```powershell
npm install --global pnpm@10.11.0
pnpm --version
# Kết quả phải là 10.11.0. Từ root repository:
Set-Location WebApp/frontend
pnpm install --frozen-lockfile
```

Kết quả: dependencies đúng lockfile.

**Bước 2 — Dev server:**

Lệnh `pnpm dev`, backend Docker, cổng/proxy và cách dừng/chạy lại được hướng dẫn tại [lifecycle WebApp riêng](../README.md#webapp-khi-chưa-chạy-kag).

**Bước 3 — Kiểm thay đổi:** chọn kiểm tra phù hợp, trong cùng thư mục:

```powershell
pnpm test
node node_modules/typescript/bin/tsc --noEmit
pnpm build
```

Kết quả kiểm hợp đồng frontend, kiểu và bundle; không xác nhận graph/provider live.

## Mã nguồn và hợp đồng

- [App.tsx](src/App.tsx): routes/phân vai; [pages/](src/pages/): trang đang dùng; [pages/shared/](src/pages/shared/): nội dung, KAG và state/API dùng chung.
- [api.ts](src/api.ts), [auth.tsx](src/auth.tsx): API/JWT; JWT ở sessionStorage, vai trò từ `/auth/me`, server kiểm quyền. Logout/401 xóa phiên và bài thi đang chọn.
- [admin/](src/admin/): UI primitive, store và parser nhập dữ liệu dùng chung cho các trang.
- [tests/](tests/): auth/import/API/chat/inspection. API lỗi phải hiện lỗi, không thay bằng dữ liệu mẫu.

Nhập dùng preview/confirm backend, giữ nháp; JSON đáp án từ 0, CSV/XLSX 1–4. Chat UI dùng SSE `/chat/stream?progress=true` ([chat-state.ts](src/pages/shared/chat-state.ts)); backend gọi KAG `/v1/query`. Browser không điều khiển Docker/Python.

Phạm vi và các giới hạn chức năng chỉ duy trì tại [USER-GUIDE](../../docs/USER-GUIDE.md). Hợp đồng KAG: [kiến trúc](../../docs/architecture.md#hợp-đồng-http-và-chính-sách-tương-thích).

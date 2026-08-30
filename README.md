# Bot Anti-Raid Security

Bot Discord bảo vệ cấu trúc server và phát hiện raid theo thời gian thực. Dự án tập trung vào phản ứng sớm, trust tiers, lockdown, snapshot/restore và giao diện sạch không phụ thuộc emoji mặc định của Discord.

## Tính năng hiện có

- Phát hiện từ sự kiện audit log: mass-ban, xóa/tạo/sửa channel, xóa/sửa role, thêm bot lạ, tạo webhook và cấp role nguy hiểm.
- Phản ứng theo cửa sổ thời gian, xử lý tác nhân bằng ban, kick hoặc cách ly role.
- Emergency Lockdown và khôi phục chính xác các quyền lockdown từ snapshot.
- Snapshot role, channel, permission overwrite và assignment role của thành viên.
- Tạo lại channel/role bị xóa; tự unban nạn nhân và trả role khi họ vào lại server.
- Message Guard xử lý flood, raid nội dung phối hợp, zero-width/homoglyph và link có dấu hiệu giả mạo. Nội dung chỉ được xử lý trong RAM.
- Slash commands quản trị, security log dạng embed và health endpoint `/health`.
- Application Emoji tùy chọn để hình ảnh đồng nhất trên mọi server.

## Yêu cầu Discord

Trong Discord Developer Portal, bật:

- Server Members Intent
- Message Content Intent

Bot cần các quyền: View Audit Log, Manage Server, Manage Channels, Manage Roles, Ban Members, Kick Members, Manage Webhooks, Manage Messages và Moderate Members. Role bot phải nằm trên mọi role mà bot cần xử lý hoặc khôi phục.

Danh sách trên là chế độ least-privilege. Nếu cần phục hồi nguyên trạng một role có quyền `Administrator` hoặc các quyền nằm ngoài danh sách, chính bot cũng phải có quyền tương ứng; cân nhắc kỹ vì quyền của bot càng cao thì việc bảo vệ token càng quan trọng.

Không cấp token cũ đã từng được gửi trong chat. Hãy vào **Developer Portal > Bot > Reset Token** và chỉ lưu token mới trong `.env` hoặc secret manager của hosting.

## Chạy local

```bash
cp .env.example .env
npm ci
npm run commands:deploy
npm run dev
```

Nếu có `DEV_GUILD_ID`, slash commands được cập nhật ngay trong server thử nghiệm. Bỏ biến này để deploy commands toàn cục; Discord có thể cần thời gian để phân phối.

## Thiết lập trong Discord

```text
/guard setup log-channel:#security-log
/guard enable
/guard status
```

Các lệnh còn lại:

- `/guard trust-user`, `/guard trust-role`, `/guard trust-bot`
- `/guard threshold`
- `/guard response-action`
- `/guard message-guard`
- `/guard snapshot-create`, `/guard snapshot-restore`
- `/guard lockdown`
- `/guard incidents`

## Emoji riêng của bot

Nên tải hình 128x128 lên **Application Emojis** trong Developer Portal rồi điền ID vào các biến `EMOJI_*_ID`. Application Emoji thuộc bot, dùng được ở mọi server và không phụ thuộc quyền Use External Emojis. Nếu để trống, bot dùng nhãn chữ `[SHIELD]`, `[ALERT]`, `[LOCK]`, `[RESTORE]`.

## Deploy

### Docker

```bash
docker build -t bot-anti-raid .
docker run -d --restart unless-stopped --env-file .env -p 3000:3000 -v anti-raid-data:/app/data bot-anti-raid
```

### Node/PM2

```bash
npm ci
npm run build
npx pm2 start ecosystem.config.cjs
```

Entry point production là `dist/index.js`. Thư mục `data/` cần volume bền vững và không được deploy đè/xóa.

## Giới hạn kỹ thuật cần biết

- Discord không cho bot tự đưa một người đã bị ban trở lại server. Bot sẽ unban ngay; người đó cần vào lại bằng invite, sau đó role được trả tự động.
- Discord không cho tạo lại đúng snowflake ID của channel/role đã xóa. Bot phục hồi tên, loại, vị trí, quyền và assignment, nhưng tích hợp bên ngoài tham chiếu ID cũ cần cập nhật.
- Không có bot nào có thể xử lý người đứng trên role của chính nó. Hãy đặt role bảo mật đủ cao, nhưng vẫn dưới chủ server.
- Snapshot định kỳ bị hoãn khi lockdown hoặc vừa có hoạt động không tin cậy để tránh lưu trạng thái đã bị phá.

## Quy trình GitHub và hosting SFTP

Workflow CI đã có sẵn để test/build mỗi lần push. Chưa bật auto-deploy SFTP vì cần biết **thư mục chạy chính xác trên hosting** và **lệnh lifecycle sau khi upload**. Không lưu mật khẩu SFTP hoặc token Discord trong repository; chúng phải là GitHub Actions Secrets hoặc secret của hosting.

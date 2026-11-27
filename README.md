# Dòng Tiền

Ứng dụng quản lý thu chi, tài sản và khoản nợ bằng HTML/CSS/JavaScript thuần. Đăng nhập bằng email/mật khẩu hoặc Google; mọi dữ liệu tài chính đã đăng nhập được lưu trong Supabase SQL. Mỗi tài khoản có không gian cá nhân riêng và có thể tham gia không gian gia đình. Chỉ dữ liệu được tạo trong một không gian gia đình mới hiển thị với các thành viên của không gian đó.

## Chạy và kiểm tra

Yêu cầu Node.js 18 trở lên:

```powershell
npm start
npm run check
npm test
```

Mở `http://localhost:3000`. Cần cấu hình Supabase mới có thể đăng nhập; ứng dụng không hiển thị sổ tài chính khi chưa xác thực. JSON sao lưu/khôi phục vẫn có trong **Cài đặt**. Dữ liệu cũ từng lưu trên trình duyệt có thể được chuyển lên không gian cá nhân sau khi đăng nhập.

## Tạo Supabase

1. Tạo dự án Supabase. Trên dự án mới, chạy [`supabase/schema.sql`](supabase/schema.sql) một lần để tạo schema nền. Với dự án đang dùng, không tạo lại cơ sở dữ liệu; trước hết tạo bản sao lưu, ghi nhận số dòng/tổng số dư của `transactions`, `assets` và `debts`, rồi chạy migrations bổ sung theo thứ tự tên: `20261127000000`, `20261127010000`, `20261127120000`. Ưu tiên Supabase CLI để migration được ghi vào lịch sử phiên bản: `supabase link --project-ref <project-ref>`, kiểm tra `supabase migration list`, rồi chạy `supabase db push`. Nếu phải chạy SQL Editor, chạy từng file theo đúng thứ tự; chỉ sau khi file hoàn tất và các kiểm tra hậu migration đạt yêu cầu mới đăng ký các phiên bản đã chạy bằng `supabase migration repair --status applied <timestamp...>`. Không đánh dấu file lỗi hoặc chạy dở là đã áp dụng. Các migration bổ sung, không xóa hoặc đổi ID/nhãn giao dịch cũ. Trước production, chạy trên staging có bản sao dữ liệu và kiểm tra [`supabase/verification/ledger-parity.sql`](supabase/verification/ledger-parity.sql); hai kết quả phải rỗng. So sánh số dòng, tổng thu/chi và số dư trước/sau, giữ bản sao lưu đã kiểm tra để phục hồi nếu xác thực thất bại.
2. Trong **Project Settings → API**, dùng Project URL và **anon/public (publishable) key**. Không đưa service-role/secret key vào website, Vercel environment variables hoặc bất kỳ tệp nào được phân phối cho trình duyệt.
3. Với chạy local, sao chép `supabase-config.example.js` thành `supabase-config.js`, điền URL và public key, sau đó chạy `npm start`. Tệp local này được Git bỏ qua. Tài khoản mới có thể cần xác nhận email theo thiết lập Auth của dự án.
4. Trong **Authentication → URL Configuration**, đặt **Site URL** là URL production. Thêm chính xác các URL callback được dùng vào **Redirect URLs**, ví dụ `http://localhost:3000/**`, `https://your-domain.example/**` và các domain Preview của Vercel mà bạn cho phép. Không dùng wildcard rộng hơn phạm vi domain của dự án.
5. Để đưa dữ liệu cũ từ browser localStorage lên tài khoản, đăng nhập bằng cùng trình duyệt, mở **Cài đặt → Chuyển dữ liệu trên thiết bị** và xác nhận thay thế dữ liệu trong không gian cá nhân. Dữ liệu cũ không tự động tải lên hoặc được chia sẻ.

## Đăng nhập Google (cần chủ dự án cấu hình)

1. Trong Google Cloud Console, tạo OAuth Client ID kiểu **Web application**. Thêm domain production, `http://localhost:3000` và từng origin Preview được phép vào **Authorized JavaScript origins**.
2. Trong Supabase **Authentication → Providers → Google**, bật Google và nhập OAuth Client ID/Client Secret. Supabase hiển thị callback URI theo dạng `https://<project-ref>.supabase.co/auth/v1/callback`; thêm URI chính xác đó vào **Authorized redirect URIs** trong Google Cloud.
3. Lưu cấu hình Google, rồi kiểm tra Site URL/Redirect URLs ở Supabase. Client secret chỉ được nhập vào Supabase, không commit vào repository. Người dùng sẽ được yêu cầu xác nhận email trước khi chấp nhận lời mời gia đình.

## Email mời và liên kết gia đình an toàn

RLS giới hạn mọi truy vấn theo membership của không gian. Link mời chứa token ngẫu nhiên 256-bit; cơ sở dữ liệu chỉ lưu SHA-256 digest, link dùng một lần, hết hạn sau 7 ngày, có thể thu hồi, và lời mời email chỉ được chấp nhận bởi tài khoản có email đã xác minh trùng với người nhận. Giới hạn tối đa 50 lời mời đang hiệu lực cho mỗi không gian. Chỉ owner/admin có thể quản lý lời mời/thành viên; chỉ owner có thể xóa không gian hoặc thay đổi quyền admin. Thành viên có thể xem, thêm, sửa và xóa dữ liệu trong không gian gia đình. Sao lưu/khôi phục/xóa toàn bộ chỉ hoạt động trong không gian cá nhân.

Gửi email thực hiện qua Supabase Edge Function `send-invite` và Resend; không có service-role key trong client hoặc Edge Function. Chủ dự án cần:

1. Cài Supabase CLI, đăng nhập và liên kết thư mục này với project (`supabase login`, `supabase link --project-ref your-project-ref`).
2. Xác minh domain gửi thư trong Resend và chọn địa chỉ `from` trên domain đó.
3. Đặt các secrets cho Edge Function rồi deploy:

   ```powershell
   supabase secrets set RESEND_API_KEY="re_replace-with-your-key" INVITE_FROM_EMAIL="finance@your-domain.example" PUBLIC_APP_URL="https://your-domain.example"
   supabase functions deploy send-invite
   ```

`SUPABASE_URL` và `SUPABASE_ANON_KEY` do môi trường Supabase Edge Functions cung cấp. `PUBLIC_APP_URL` phải là origin triển khai ứng dụng được tin cậy; cập nhật lại khi đổi domain. Nếu Resend gửi thất bại, lời mời được thu hồi tự động. Tạo liên kết chia sẻ không cần gửi email; link chỉ được phát hành sau khi RLS/RPC xác nhận người tạo là owner/admin.

## Triển khai Vercel

1. Import repository vào Vercel. Chọn **Framework Preset: Other**, Build Command `npm run build`, Output Directory `dist`.
2. Trong **Project Settings → Environment Variables**, thêm `SUPABASE_URL` và `SUPABASE_ANON_KEY`, dùng public anon/publishable key cho Production và các Preview cần thiết. Những giá trị này được nhúng vào client bundle; không bao giờ đặt service-role key ở đây. Build từ chối các giá trị có dạng secret/service-role.
3. Cấu hình Supabase Auth URL và Google OAuth như trên cho từng domain dùng được; đặt `PUBLIC_APP_URL` của Edge Function trùng domain chính thức muốn tạo link mời.
4. Triển khai `send-invite` riêng bằng Supabase CLI như phần trên. Sau đó build/redeploy Vercel khi thay đổi biến môi trường hoặc domain.

RLS là ranh giới bảo vệ dữ liệu; không dựa vào bộ lọc UI. Mọi record phải thuộc một `space_id` và chỉ thành viên của đúng space mới đọc/ghi được. Chạy `npm test` để kiểm tra các guard quan trọng ở client/schema/Edge Function; kiểm tra đăng nhập, Google OAuth, RLS và gửi email thật cần project Supabase/Google/Resend đã cấu hình bởi chủ dự án.

## Sổ giao dịch, số dư và báo cáo

Giao dịch, tài sản, khoản phải trả và biến động số dư được tải theo trang keyset có giới hạn; tìm tài khoản liên kết cũng chỉ trả tối đa 25 kết quả. Bộ đếm, tổng thu/chi, số dư, tỷ lệ chi/thu, tỷ lệ tiết kiệm, trả nợ/vay/mua tài sản trong tháng và tổng hợp theo loại được tính trong PostgreSQL qua RPC có kiểm tra membership và phạm vi `space_id`, không tính từ các trang đang hiển thị. Dữ liệu tài chính vẫn được bảo vệ bởi RLS.

Sổ biến động append-only ghi số dư mở đầu, điều chỉnh, giao dịch, chuyển khoản, mua tài sản, vay và trả nợ; RLS chỉ cho thành viên của đúng không gian đọc. Giao dịch không liên kết không tự làm thay đổi số dư tài sản/khoản phải trả. Giao dịch có thể liên kết tối đa hai khoản mục để ghi hai vế; cập nhật/xóa giao dịch sẽ tạo biến động đảo và không cộng lặp số dư. Chuyển khoản/mua tài sản chuyển cùng một số tiền giữa hai tài sản; trả nợ giảm cả tài sản tiền trả và khoản phải trả; vay mới tăng cả tiền nhận và khoản phải trả. Dùng một cách ghi cho mỗi sự kiện thực tế, không ghi thêm biến động độc lập nếu giao dịch liên kết đã ghi cùng sự kiện.

Loại tài sản/khoản phải trả và trạng thái thanh khoản được cấu hình theo không gian. Loại đã dùng, tài khoản và danh mục được lưu trữ thay vì xóa cứng; nhãn giao dịch cũ và lịch sử biến động vẫn được giữ lại. Bản sao lưu v2 bao gồm các trang đầy đủ của giao dịch, tài khoản đã lưu trữ và biến động; tệp v1 vẫn có thể được khôi phục nhưng không chứa lịch sử biến động độc lập. Khôi phục toàn bộ chỉ áp dụng cho không gian cá nhân và không xóa sổ biến động hiện có. Giá trị tài sản là số dư do người dùng ghi nhận, không phải định giá thị trường. Giá trị ròng là tổng tài sản trừ nợ; luồng thu/chi được báo cáo riêng.

Danh mục thu nhập/chi tiêu và loại tài sản/khoản phải trả được cấu hình theo không gian; có thể đổi tên, bật/tắt thanh khoản và lưu trữ. Không xóa cứng cấu hình đã dùng; giao dịch tiếp tục giữ nhãn danh mục tại thời điểm ghi nhận. Các migration có tính bổ sung để có thể khôi phục bản website trước đó mà không gỡ schema. Không có migration down tự động vì xóa movement sẽ làm mất kiểm toán; khi cần rollback ứng dụng, triển khai lại phiên bản website trước mà vẫn giữ schema mới. Khi cần khôi phục dữ liệu, kiểm tra bản sao lưu và phục hồi trong môi trường riêng trước khi thay thế dữ liệu production. Không xóa thủ công cột/liên kết hoặc bảng biến động sau khi đã sử dụng.

`npm test` kiểm tra hành vi khởi động/thử lại cùng các hợp đồng UI và cấu trúc SQL; nó không thực thi migration, trigger hoặc RLS trên PostgreSQL. Vì vậy không xem phân tích cú pháp SQL là xác nhận migration chạy đúng. Trước khi phát hành database, dùng bản sao staging để kiểm tra thêm: tạo/sửa/xóa giao dịch hai vế, giao dịch không liên kết, chuyển tiền/mua tài sản không làm tăng tổng tài sản, trả nợ/vay, trang kế tiếp với cùng timestamp, báo cáo kỳ trống và tải dữ liệu giả lập lớn. Ghi thời gian và kế hoạch thực thi `EXPLAIN (ANALYZE, BUFFERS)` cho RPC phân trang/tổng hợp; chỉ cân nhắc partitioning nếu đo đạc cho thấy index và keyset hiện tại không đáp ứng được.

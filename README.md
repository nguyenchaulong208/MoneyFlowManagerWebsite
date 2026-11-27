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

1. Tạo dự án Supabase. Trước khi nâng cấp cơ sở dữ liệu đang dùng, tạo bản sao lưu và kiểm tra số dòng hiện có trong `transactions`, `assets` và `debts`. Chạy toàn bộ [`supabase/schema.sql`](supabase/schema.sql) trong **SQL Editor**, sau đó chạy các tệp trong [`supabase/migrations`](supabase/migrations) theo thứ tự tên. Migration sổ cái chỉ bổ sung cột, chỉ mục, hàm và danh mục mặc định; không xóa hoặc đổi ID/nhãn giao dịch cũ. Sau khi chạy, xác nhận lại số dòng và dữ liệu trong các không gian trước khi đưa phiên bản website mới lên production. Giữ bản sao lưu để có thể khôi phục nếu kiểm tra thất bại.
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

Giao dịch được tải theo trang keyset (ngày và ID), giới hạn 50 dòng mỗi lần; nút **Tải thêm giao dịch** lấy trang tiếp theo. Bộ đếm, tổng thu/chi và báo cáo tháng được tính trong PostgreSQL qua RPC có kiểm tra membership và phạm vi `space_id`, không tính từ các trang đang hiển thị. Dữ liệu tài chính vẫn được bảo vệ bởi RLS.

Giao dịch không liên kết không tự làm thay đổi số dư tài sản/khoản nợ. Khi liên kết một giao dịch với tài sản hoặc khoản nợ, chọn rõ tăng hay giảm số dư; thay đổi và xóa giao dịch sẽ đảo/cập nhật đúng phần tác động đó trong cùng giao dịch cơ sở dữ liệu. Xóa tài sản/khoản nợ sẽ bỏ liên kết khỏi giao dịch nhưng giữ nguyên lịch sử giao dịch. Giá trị tài sản là số dư người dùng ghi nhận, không phải định giá thị trường. Giá trị ròng là tổng tài sản trừ nợ; luồng thu/chi được báo cáo riêng để không cộng hai lần khoản đã liên kết.

Danh mục thu nhập/chi tiêu được cấu hình theo không gian. Danh mục đã dùng chỉ được lưu trữ, không xóa cứng; mỗi giao dịch tiếp tục giữ nhãn đã ghi nhận để bảo toàn lịch sử. Migration được lưu theo thứ tự trong `supabase/migrations`; hãy sao lưu và xác nhận dữ liệu trước khi triển khai migration trên cơ sở dữ liệu hiện có. Migration này tương thích ngược ở tầng schema nên có thể khôi phục bản website trước đó mà không gỡ migration. Nếu cần phục hồi cơ sở dữ liệu, dùng bản sao lưu đã kiểm tra; không xóa thủ công các cột/liên kết sau khi đã ghi nhận giao dịch có liên kết vì việc đó sẽ làm mất thông tin sổ cái.

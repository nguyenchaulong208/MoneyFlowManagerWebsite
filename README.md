# Dòng Tiền

Ứng dụng quản lý tài chính cá nhân bằng HTML, CSS và JavaScript thuần. Theo dõi thu chi, tài sản, khoản nợ và báo cáo tháng; dữ liệu có thể lưu trên thiết bị hoặc đồng bộ riêng tư bằng Supabase Auth.

## Chạy website

Yêu cầu Node.js 18 trở lên:

```powershell
npm start
```

Mở `http://localhost:3000`. Cũng có thể chạy `npm run check` để kiểm tra cú pháp JavaScript.

## Dùng Supabase

Ứng dụng hoạt động ngay ở chế độ chỉ lưu trong trình duyệt. Để bật tài khoản và đồng bộ:

1. Tạo một dự án Supabase, sau đó mở **SQL Editor** và chạy toàn bộ nội dung [`supabase/schema.sql`](supabase/schema.sql). Schema tạo các bảng `transactions`, `assets`, `debts`, bật RLS với chính sách chỉ cho phép người dùng truy cập dữ liệu của mình, và thêm hàm khôi phục bản sao lưu an toàn.
2. Khi chạy website trực tiếp trên máy, sao chép `supabase-config.example.js` thành `supabase-config.js`, rồi điền Project URL và **anon/public key** của dự án. Hai giá trị công khai này có thể dùng trong trình duyệt khi RLS được bật. Không điền service-role/secret key; tệp `supabase-config.js` đã được Git bỏ qua.
3. Chạy website, mở **Cài đặt → Kết nối tài khoản**, rồi tạo tài khoản hoặc đăng nhập. Nếu bật xác nhận email trong Supabase Auth, hãy xác nhận email trước khi đăng nhập.
4. Dữ liệu cũ trên thiết bị không tự tải lên. Khi đã đăng nhập, chọn **Chuyển dữ liệu trên thiết bị** và xác nhận nếu muốn thay thế dữ liệu đang có trên tài khoản bằng bản dữ liệu cục bộ.

Khi đăng xuất, ứng dụng quay lại dữ liệu trên thiết bị mà không xóa dữ liệu Supabase. Sao lưu/khôi phục JSON và xóa dữ liệu thao tác trên nguồn dữ liệu đang hoạt động. Chỉ tải cấu hình lên hosting đáng tin cậy; trình duyệt cần kết nối mạng tới Supabase và CDN để dùng đồng bộ.

## Triển khai và kết nối Supabase qua Vercel

Vercel build website thành các tệp tĩnh trong `dist/`; trong lúc build, ứng dụng tạo `supabase-config.js` từ environment variables. Tệp cấu hình sinh ra không được commit.

1. Import repository này vào Vercel. Đặt **Root Directory** là thư mục chứa `package.json`; dùng Framework Preset **Other**, Build Command `npm run build`, Output Directory `dist`.
2. Trong **Project Settings → Environment Variables**, thêm `SUPABASE_URL` bằng Project URL và `SUPABASE_ANON_KEY` bằng **anon/public (publishable) key** trong Supabase. Chọn các môi trường cần dùng: Production, Preview và/hoặc Development. Không thêm service-role/secret key. Các giá trị này được nhúng vào tệp JavaScript công khai lúc build, nên chỉ dùng key dành cho trình duyệt và luôn bật RLS.
3. Trong Supabase **Authentication → URL Configuration**, đặt **Site URL** thành địa chỉ production của Vercel, ví dụ `https://ten-du-an.vercel.app`. Thêm URL production và các URL preview cần đăng nhập vào **Redirect URLs**.
4. Lưu cấu hình và deploy/redeploy trên Vercel. Mỗi lần thay đổi environment variables cần build/deploy lại. Mở website, tạo tài khoản trong **Cài đặt → Kết nối tài khoản**, rồi kiểm tra đăng nhập và đồng bộ.

Có thể kiểm tra build trước khi deploy bằng cách đặt hai biến môi trường trên máy rồi chạy `npm run build`. Build sẽ dừng với lỗi rõ ràng nếu thiếu URL/key hoặc phát hiện service-role/secret key. Lệnh `npm start` tiếp tục phục vụ chế độ local; để bật Supabase khi chạy local, dùng tệp `supabase-config.js` như hướng dẫn ở trên.

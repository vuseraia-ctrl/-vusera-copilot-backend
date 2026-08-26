# VUSERA Employee Copilot — Backend

Real RAG (Retrieval-Augmented Generation) sistemi: şirkət sənədlərini "başa düşür", rol-əsaslı icazə tətbiq edir, Claude ilə cavab verir.

## Necə işləyir

1. Sənədlər kiçik "chunk"lara (parçalara) bölünür
2. Hər parça üçün Voyage AI ilə "embedding" (rəqəmsal məna) yaradılır, Supabase-də saxlanılır
3. İşçi sual verəndə, sualın öz embedding-i yaradılır, ən oxşar 4 parça tapılır (vector axtarış)
4. İşçinin roluna görə icazəsi olmayan parçalar süzülür
5. Yalnız icazəli parçalar Claude-a göndərilir, cavab (mənbə ilə) qaytarılır

## Quraşdırma (addım-addım)

### 1. Supabase layihəsi yaradın
- supabase.com-da pulsuz hesab açın
- "New Project" yaradın
- SQL Editor-a keçin, `schema.sql` faylının içindəkini yapışdırıb "Run" edin
- Settings → API bölməsindən `Project URL` və `service_role key`-i kopyalayın

### 2. Voyage AI açarı alın
- voyageai.com-da pulsuz qeydiyyatdan keçin (200M token pulsuz)
- API açarınızı kopyalayın

### 3. Kodları hazırlayın
```
npm install
cp .env.example .env
# .env faylını açıb öz açarlarınızı yazın
```

### 4. Test məlumatlarını əlavə edin (Supabase SQL Editor-da)
```sql
insert into companies (name) values ('NovaTech Solutions') returning id;
-- Yuxarıdakı sorğunun qaytardığı ID-ni köçürün, aşağıda istifadə edin

insert into departments (company_id, name) values ('BURAYA-COMPANY-ID', 'Sales') returning id;

insert into employees (company_id, department_id, name, role)
values ('BURAYA-COMPANY-ID', 'BURAYA-DEPT-ID', 'Liam Anderson', 'Sales Specialist')
returning id;
```

### 5. Sənədləri yükləyin

**Yol A — kompüterdə Node.js varsa:**
```
node ingest.js "COMPANY-ID" "Leave Policy" "HR-002" "./docs/leave-policy.txt" ""
```

**Yol B — server artıq deploy olunubsa (Node.js lazım deyil):**
POST sorğusu göndərin (Make.com HTTP modulu, Postman və ya bənzər bir alətlə):
```
POST https://sizin-server-url.onrender.com/ingest
Content-Type: application/json

{
  "companyId": "COMPANY-ID",
  "title": "Leave Policy",
  "docCode": "HR-002",
  "content": "Section 4.2 — ... (sənədin tam mətni)",
  "restrictedRoles": []
}
```
(Məhdud sənəd üçün: `"restrictedRoles": ["HR Manager", "Finance Manager", "Admin"]`)

### 6. Serveri işə salın
```
npm start
```

### 7. Test edin
```
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"employeeId": "BURAYA-EMPLOYEE-ID", "question": "Məzuniyyət neçə gündür?"}'
```

## Real internetə çıxarmaq (deployment)

Pulsuz seçimlər: **Render.com** və ya **Railway.app**
1. Bu kodu GitHub-a yükləyin
2. Render/Railway-də "New Web Service" yaradın, GitHub repo-nu bağlayın
3. Environment variables bölməsində `.env`-dəki açarları əlavə edin
4. Deploy edin — sizə bir canlı URL veriləcək (məs: `https://vusera-copilot.onrender.com`)

## Növbəti addımlar

- Frontend-i (bugünkü demo HTML-i) bu real API-yə bağlamaq
- Make.com ilə əməliyyat sorğularını (leave_request və s.) real Google Calendar/HR sistemə bağlamaq
- Admin dashboard (chat_logs cədvəlindən "top questions" analitikası)

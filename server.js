// server.js — VUSERA Employee Copilot API
//
// Endpoint-lər:
//   POST /ask        — işçi sual verir, RAG ilə cavab alır (mənbə/xülasə/action ilə)
//   GET  /employees   — demo üçün işçi siyahısı
//   GET  /actions/:employeeId — işçinin yaratdığı sorğular

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import PDFDocument from 'pdfkit';
import { supabase, supabaseAuth, getEmbedding, chunkDocument } from './lib.js';

const app = express();
app.set('trust proxy', 1); // Render bir proksi arxasında işlədiyi üçün, real IP-ni düzgün tanımaq üçün lazımdır
app.use(cors());
app.use(express.json({ limit: '10mb' })); // qəbz/PDF şəkilləri üçün böyük body limiti

// JSON formatı səhv olan sorğular üçün aydın xəta
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Göndərilən JSON formatı səhvdir' });
  }
  next(err);
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sadə UUID format yoxlaması (yanlış ID-lərə aydın xəta vermək üçün)
function isValidUUID(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ---- VUSERA Actions Router — bütün Make.com inteqrasiyaları TƏK bir webhook-dan keçir ----
// (Pulsuz Make planında yalnız 2 aktiv ssenari icazəli olduğu üçün, hamısını "action" sahəsinə görə
// bir Router-də birləşdirmişik: send_email | check_calendar | create_meeting | read_emails)
async function callVuseraRouter(action, payload) {
  if (!process.env.MAKE_ROUTER_URL) return null;
  try {
    const response = await fetch(process.env.MAKE_ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
    return await response.json();
  } catch (e) {
    console.error(`Router (${action}) xətası:`, e.message);
    return null;
  }
}

async function readRecentEmails() {
  const data = await callVuseraRouter('read_emails', {});
  return data?.emails || [];
}

async function sendEmailViaMake(to, subject, body) {
  const data = await callVuseraRouter('send_email', { to, subject, body });
  return { success: data?.success === true };
}

async function checkCalendarAvailability(timeMin, timeMax) {
  const data = await callVuseraRouter('check_calendar', { timeMin, timeMax });
  return data?.busy || [];
}

async function createMeetingViaMake(title, startDateTime, endDateTime, description) {
  // "end" tarixi Google Calendar modulunda qəribə bir xəta verdiyi üçün, bunun əvəzinə
  // müddəti (HH:mm formatında) hesablayıb göndəririk — bu, daha etibarlı işləyir.
  let duration = '00:30';
  try {
    const diffMs = new Date(endDateTime) - new Date(startDateTime);
    if (diffMs > 0) {
      const totalMinutes = Math.round(diffMs / 60000);
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      duration = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  } catch (e) { /* default 00:30 qalır */ }

  // "+04:00" formatındakı "+" işarəsi webhook ötürülməsində korlana bildiyi üçün,
  // tarixi UTC-yə çeviririk (sonu "Z" ilə bitən format, "+" işarəsi olmadan)
  let safeStartDateTime = startDateTime;
  try {
    safeStartDateTime = new Date(startDateTime).toISOString();
  } catch (e) { /* orijinal dəyər qalır */ }

  const data = await callVuseraRouter('create_meeting', { title, startDateTime: safeStartDateTime, duration, description });
  return { success: data?.success === true, eventLink: data?.eventLink, eventId: data?.eventId };
}

async function cancelMeetingViaMake(eventId) {
  const data = await callVuseraRouter('cancel_meeting', { eventId });
  return { success: data?.success === true };
}

// PDFKit-in standart şrifti Azərbaycan hərflərini (ə,ş,ç,ğ,ı,ö,ü) dəstəkləmir —
// bunları oxunaqlı latın hərflərinə çeviririk ki, PDF-də zir-zibil (mojibake) çıxmasın
function toPdfSafeText(text) {
  if (!text) return '';
  const map = { 'ə':'e', 'Ə':'E', 'ş':'sh', 'Ş':'Sh', 'ç':'ch', 'Ç':'Ch', 'ğ':'g', 'Ğ':'G', 'ı':'i', 'İ':'I', 'ö':'o', 'Ö':'O', 'ü':'u', 'Ü':'U' };
  return text.replace(/[əƏşŞçÇğĞıİöÖüÜ]/g, ch => map[ch] || ch);
}
async function generateReportPdf(companyId, reportTitle, filters) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1) Məlumatı verilənlər bazasından çək
      let query = supabase
        .from('action_requests')
        .select('*, employees!employee_id(name, role)')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false });

      if (filters.type) query = query.eq('type', filters.type);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.sinceDays) {
        const since = new Date(Date.now() - filters.sinceDays * 24 * 60 * 60 * 1000).toISOString();
        query = query.gte('created_at', since);
      }

      const { data: rows, error } = await query;
      if (error) throw error;

      // 2) PDF-i "yaddaşda" (memory-də) qur
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(chunks);

        // 3) Supabase Storage-a yüklə
        const fileName = `${companyId}/reports/${Date.now()}-report.pdf`;
        const { error: uploadError } = await supabase.storage
          .from('documents')
          .upload(fileName, pdfBuffer, { contentType: 'application/pdf' });

        if (uploadError) return resolve({ success: false, error: uploadError.message });

        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
        resolve({ success: true, url: urlData?.publicUrl, rowCount: rows.length });
      });

      // 4) PDF məzmununu yaz
      doc.fontSize(20).text('VUSERA', { align: 'center' });
      doc.fontSize(14).fillColor('#8B6CFF').text(toPdfSafeText(reportTitle), { align: 'center' });
      doc.moveDown();
      doc.fontSize(10).fillColor('gray').text(`Yaradilma tarixi: ${new Date().toLocaleDateString('az-AZ')}`, { align: 'center' });
      doc.moveDown(2);
      doc.fillColor('black');

      if (!rows || rows.length === 0) {
        doc.fontSize(12).text('Bu filtre uygun hec bir qeyd tapilmadi.');
      } else {
        rows.forEach((r, i) => {
          doc.fontSize(12).fillColor('#4F8CFF').text(`${i + 1}. ${toPdfSafeText(r.title)}`);
          doc.fontSize(10).fillColor('black').text(`   Nov: ${r.type} | Status: ${r.status} | Isci: ${toPdfSafeText(r.employees?.name || '-')}`);
          doc.text(`   Tarix: ${new Date(r.created_at).toLocaleDateString('az-AZ')}`);
          if (r.detail) doc.text(`   Detal: ${toPdfSafeText(r.detail)}`);
          doc.moveDown(0.5);
        });
        doc.moveDown();
        doc.fontSize(11).fillColor('#4ADE80').text(`Umumi qeyd sayi: ${rows.length}`);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Sualın email haqqında olub-olmadığını sadəcə açar sözlərlə yoxlayır
function isEmailRelated(question) {
  const keywords = ['email', 'e-mail', 'e-poçt', 'epoçt', 'poçt', 'məktub', 'inbox', 'gələn qutu'];
  const lower = question.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ---- REAL LOGIN sistemi ----

// İstifadəçi email+parol ilə daxil olur, əvəzində bir "token" alır
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email və password tələb olunur' });

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Email və ya parol yanlışdır' });

    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, departments(name)')
      .eq('auth_user_id', data.user.id)
      .single();
    if (empError || !employee) return res.status(404).json({ error: 'Bu istifadəçiyə bağlı işçi tapılmadı' });

    res.json({
      token: data.session.access_token,
      employee: { id: employee.id, name: employee.name, role: employee.role, department: employee.departments?.name }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bu, gələn "Bearer token"-i yoxlayır və hansı işçi olduğunu tapıb req.employee-yə yazır.
// Bütün şəxsi/həssas endpoint-lər bunu tələb edir — artıq sadəcə ID bilməklə başqasının yerinə keçmək mümkün deyil.
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Giriş tələb olunur (token yoxdur)' });
  }
  const token = authHeader.replace('Bearer ', '');

  try {
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
    if (userError || !userData?.user) return res.status(401).json({ error: 'Token etibarsızdır və ya vaxtı bitib' });

    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, departments(name)')
      .eq('auth_user_id', userData.user.id)
      .single();
    if (empError || !employee) return res.status(404).json({ error: 'İstifadəçiyə bağlı işçi tapılmadı' });

    req.employee = employee;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Giriş yoxlaması uğursuz oldu' });
  }
}

// İstifadəçi kimliyini (əvvəlcədən saxlanılan tokenlə) yoxlamaq üçün
app.get('/auth/me', requireAuth, async (req, res) => {
  res.json({ employee: { id: req.employee.id, name: req.employee.name, role: req.employee.role, department: req.employee.departments?.name } });
});

// Verilənlər bazasında in-app bildiriş yaradır (fire-and-forget — uğursuz olsa əsas əməliyyatı pozmasın)
async function createNotification(companyId, employeeId, message, relatedActionId = null) {
  try {
    await supabase.from('notifications').insert({
      company_id: companyId,
      employee_id: employeeId,
      message,
      related_action_id: relatedActionId
    });
  } catch (e) {
    console.error('Bildiriş yaradıla bilmədi:', e.message);
  }
}

// ---- Sadə API açarı yoxlaması (tam authentication deyil, amma təsadüfi sorğulara qarşı maneədir) ----
// Real login sistemi qurulana qədər, hər sorğu bu gizli açarı bilməlidir.
function checkApiSecret(req, res, next) {
  const provided = req.headers['x-api-secret'];
  if (!process.env.API_SECRET) return next(); // .env-də təyin olunmayıbsa, keçir (development üçün)
  if (provided !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Etibarsız API açarı' });
  }
  next();
}
app.use(checkApiSecret);

// ---- Rate limiting — sui-istifadəyə/həddindən artıq sorğuya qarşı əlavə maneə ----
// Auth sistemi olmadığı üçün, ən azı hər IP-nin dəqiqədə etdiyi sorğu sayını məhdudlaşdırırıq.
const askLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 dəqiqə
  max: 20,             // hər IP üçün dəqiqədə maksimum 20 sorğu
  message: { error: 'Çox tez-tez sorğu göndərirsiniz. Bir azdan yenidən cəhd edin.' },
  standardHeaders: true,
  legacyHeaders: false
});
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // sənəd yükləmə daha az tez-tez baş verir
  message: { error: 'Çox tez-tez sənəd yükləyirsiniz. Bir azdan yenidən cəhd edin.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ---- Köməkçi funksiyalar ----

// Rolun "yüksək icazəli" olub-olmadığını yoxlayır (HR/Finance Manager, Admin)
function hasElevatedAccess(role) {
  return ['HR Manager', 'Finance Manager', 'Admin'].includes(role);
}

// Tapılan parçaları işçinin roluna görə filtrlə — icazəsi olmayan sənədləri çıxar
function filterByPermission(chunks, employeeRole) {
  return chunks.filter(chunk => {
    if (!chunk.restricted_to_roles || chunk.restricted_to_roles.length === 0) return true;
    return chunk.restricted_to_roles.includes(employeeRole);
  });
}

// ---- Əsas endpoint: /ask ----

app.post('/ask', askLimiter, requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    const employeeId = req.employee.id; // artıq body-dən deyil, dogrulanmış tokendən gəlir
    if (typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'question boş ola bilməz' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: 'Sual çox uzundur (maksimum 2000 simvol)' });
    }

    // 1) İşçini tap (rol, şirkət)
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, departments(name)')
      .eq('id', employeeId)
      .single();
    if (empError || !employee) return res.status(404).json({ error: 'İşçi tapılmadı' });

    // 2) Sualın embedding-ini yarat
    let queryEmbedding;
    try {
      queryEmbedding = await getEmbedding(question);
    } catch (e) {
      console.error('Voyage AI xətası:', e.message);
      return res.status(503).json({ error: 'Axtarış sistemi hazırda əlçatan deyil. Bir azdan yenidən cəhd edin.' });
    }

    // 3) Vector axtarışı ilə ən oxşar 4 parçanı tap
    const { data: matches, error: matchError } = await supabase.rpc('match_chunks', {
      query_embedding: queryEmbedding,
      match_company_id: employee.company_id,
      match_count: 4
    });
    if (matchError) throw matchError;

    // 3.5) Söhbət yaddaşı — bu işçinin son 6 mesajını gətir ki, Claude
    // əvvəlki sualları "xatırlaya" bilsin (məs: "bəs həftədə neçə gün?")
    const { data: history } = await supabase
      .from('chat_logs')
      .select('question, answer')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(6);

    const conversationMessages = [];
    if (history && history.length > 0) {
      // Ən köhnədən ən yeniyə doğru sırala (Claude-a düzgün xronoloji ardıcıllıqla veririk)
      for (const h of history.reverse()) {
        conversationMessages.push({ role: 'user', content: h.question });
        conversationMessages.push({ role: 'assistant', content: h.answer });
      }
    }
    conversationMessages.push({ role: 'user', content: question });

    // 3.6) Real "availability" yoxlaması — bu işçinin VERİLƏNLƏR BAZASINDAKI bütün
    // gözləyən/təsdiqlənmiş məzuniyyət tarixlərini gətiririk (yalnız söhbət yaddaşına güvənmək əvəzinə)
    const { data: existingLeaves } = await supabase
      .from('action_requests')
      .select('title, start_date, end_date, status')
      .eq('employee_id', employeeId)
      .eq('type', 'leave_request')
      .in('status', ['pending', 'approved']);

    const existingLeavesText = (existingLeaves && existingLeaves.length > 0)
      ? existingLeaves.map(l => `- ${l.start_date} — ${l.end_date} (${l.status === 'approved' ? 'təsdiqlənib' : 'gözləyir'}): ${l.title}`).join('\n')
      : '(bu işçinin heç bir aktiv məzuniyyət sorğusu yoxdur)';

    // 3.65) Əgər sual məzuniyyətlə əlaqəlidirsə, REAL Google Calendar-da (növbəti 60 gün) məşğulluğu yoxla
    let calendarBusyText = '';
    if (/mezuniyy|məzuniyy|leave|vacation|tetil|tətil/i.test(question)) {
      const now = new Date();
      const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      const busy = await checkCalendarAvailability(now.toISOString(), future.toISOString());
      if (busy && busy.length > 0) {
        calendarBusyText = `\nGOOGLE CALENDAR-DA MƏŞĞUL VAXTLAR (növbəti 60 gün, real təqvimdən):\n${busy.map(b => `- ${b.start} — ${b.end}`).join('\n')}\n`;
      } else if (busy) {
        calendarBusyText = '\nGOOGLE CALENDAR-DA MƏŞĞUL VAXTLAR: (növbəti 60 gündə heç bir məşğulluq yoxdur)\n';
      }
    }

    // 3.7) Əgər sual email haqqındadırsa, real inbox-u oxu
    let emailsText = '';
    if (isEmailRelated(question)) {
      const emails = await readRecentEmails();
      emailsText = emails.length > 0
        ? emails.map((e, i) => `${i + 1}. "${e.subject}" — ${e.fromName} (${e.fromEmail})\n   ${e.snippet}`).join('\n\n')
        : '(inbox oxunmadı və ya boşdur)';
    }

    // 3.8) Şirkət işçilərinin real email siyahısı (Claude email ünvanı UYDURMASIN deyə)
    const { data: companyDirectory } = await supabase
      .from('employees')
      .select('name, email, role')
      .eq('company_id', employee.company_id)
      .eq('status', 'active');
    const directoryText = (companyDirectory || [])
      .filter(e => e.email)
      .map(e => `- ${e.name} (${e.role}): ${e.email}`)
      .join('\n');

    // 4) İcazə süzgəcindən keçir — işçinin görə bilmədiyi sənədləri çıxar
    const allowedChunks = filterByPermission(matches || [], employee.role);

    // Əgər tapılan parçalar arasında məhdud (restricted) bir sənəd varsa,
    // amma işçinin buna icazəsi yoxdursa — bu, "tapılmadı" yox, "icazə yoxdur" deməkdir.
    // (Digər əlaqəsiz-amma-icazəli parçaların da tapılması bunu dəyişməməlidir.)
    const deniedButRelevant = (matches || []).some(
      chunk => chunk.restricted_to_roles
        && chunk.restricted_to_roles.length > 0
        && !chunk.restricted_to_roles.includes(employee.role)
    );

    // 5) Kontekst mətnini hazırla
    const contextText = allowedChunks
      .map(c => `[${c.document_title} — ${c.section_label || 'Ümumi'}]\n${c.content}`)
      .join('\n\n');

    const systemPrompt = `Sən VUSERA Employee Copilot-san. Yalnız Azərbaycan dilində cavab ver.
İstifadəçi: ${employee.name}, ${employee.departments?.name || ''}, rol: ${employee.role}.

BUGÜNKÜ TAM TARİX VƏ SAAT: ${new Date().toLocaleString('az-AZ', { timeZone: 'Asia/Baku', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (Bakı vaxtı). "Bugün", "sabah", "gələn həftə" kimi ifadələri HƏMİŞƏ bu tarixə əsasən hesabla — heç vaxt köhnə və ya təxmini il istifadə etmə.

Aşağıda bu sualla əlaqəli, sistemin indi tapdığı sənəd parçaları var (əgər söhbətin əvvəlki hissəsi varsa, onu da nəzərə al — məsələn "bəs neçə gün?" kimi davam sualları):
${contextText || '(bu sual üçün uyğun yeni sənəd tapılmadı — əvvəlki söhbətə əsaslana bilərsən, əks halda tapılmadığını de)'}

MÖVCUD MƏZUNİYYƏT SORĞULARI (bu işçinin, verilənlər bazasından — real tarix üst-üstə düşməsini yoxlamaq üçün):
${existingLeavesText}
${calendarBusyText}

${emailsText ? `SON EMAİLLƏR (Gmail-dən indi oxunub):\n${emailsText}\n` : ''}

ŞİRKƏT İŞÇİ DİREKTORİYASI (real email ünvanları — email göndərəndə YALNIZ buradakı ünvanlardan istifadə et, HEÇ VAXT ünvan uydurma):
${directoryText || '(direktoriya boşdur)'}

QAYDALAR:
1. Yalnız yuxarıdakı parçalara əsaslan, uydurma.
2. Əgər kontekst boşdursa və ya sual bununla əlaqəli deyilsə, "Bu məlumat mövcud bilik bazasında tapılmadı" de.
3. ƏMƏLİYYAT (məzuniyyət/xərc/IT problemi) İKİ ADDIMLI PROSESDİR:
   ADDIM 1 (Təklif): İstifadəçi ilk dəfə bir iş görülməsini istəyəndə, lazımi məlumatı (tarix, məbləğ, problem) topla, XÜLASƏ ET və aydın şəkildə TƏSDİQ SORUŞ (məs: "Bunu təsdiqləyirsinizmi?"). Bu addımda HEÇ VAXT ACTION yazma.
   ƏGƏR TİP leave_request-dirsə: aşağıdakı "MÖVCUD MƏZUNİYYƏT SORĞULARI" siyahısı VƏ "GOOGLE CALENDAR-DA MƏŞĞUL VAXTLAR" ilə TARİX ÜST-ÜSTƏ DÜŞMƏSİNİ yoxla, üst-üstə düşmə varsa bunu AÇIQ şəkildə xəbərdarlıq et (təsdiq soruşarkən).
   ADDIM 2 (Təsdiq): Yalnız əgər söhbətin ƏVVƏLKİ sənin mesajında artıq təklif irəli sürmüsənsə VƏ istifadəçi indi "bəli/hə/təsdiqləyirəm/et" kimi razılıq bildirirsə, cavabının sonunda bunu yaz: ACTION:{"type":"leave_request|it_ticket|expense_request","title":"...","detail":"...","priority":"low|normal|high","category":"...","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","amount":rəqəm_ve_ya_null}
   İstifadəçi "yox" desə və ya fikrini dəyişsə, ACTION yazma, "Ləğv edildi" de.
   VACİB: ACTION marker-i yazırsansa, o, cavabının MÜTLƏQ SON HİSSƏSİ olmalıdır — ondan sonra HEÇ BİR söz, HEÇ BİR salamlama, HEÇ BİR emoji yazma.
   - leave_request üçün category: "annual" | "sick" | "unpaid" | "emergency"; start_date/end_date MÜTLƏQ doldurulmalıdır (il göstərilməsə, ${new Date().getFullYear()} il qəbul et)
   - it_ticket üçün category: "hardware" | "software" | "access" | "network"; priority: problemi ciddiliyinə görə seç (mes: "işləmir" = high, "yavaşdır" = normal); start_date/end_date lazım deyil, boş buraxa bilərsən
   - expense_request üçün category: "travel" | "meals" | "office" | "other"; start_date/end_date lazım deyil; "amount" sahəsinə MÜTLƏQ rəqəm (yalnız ədəd, valyuta olmadan) yaz, məs: 2500
   ƏLAVƏ (Email): Əgər istifadəçi email GÖNDƏRMƏK istəyirsə, 2-addımlı prosesə tabedir: ADDIM 1-də draft-ı göstər, təsdiq soruş; ADDIM 2-də: ACTION:{"type":"send_email","to":"email@ünvanı","subject":"...","title":"Email göndərildi","detail":"..."}
   VACİB: "to" sahəsi YALNIZ yuxarıdakı "ŞİRKƏT İŞÇİ DİREKTORİYASI"ndakı real email ünvanlarından biri ola bilər. Direktoriyada yoxdursa, ünvan uydurma — "Bu şəxsin email ünvanı sistemdə tapılmadı" de.
   ƏLAVƏ (Görüş): Əgər istifadəçi görüş/meeting yaratmaq istəyirsə ("sabah 3-də görüş qur" kimi), 2-addımlı prosesə tabedir: ADDIM 1-də tarix/saat/başlığı göstər, təsdiq soruş; ADDIM 2-də: ACTION:{"type":"create_meeting","title":"...","startDateTime":"YYYY-MM-DDTHH:mm:00+04:00","endDateTime":"YYYY-MM-DDTHH:mm:00+04:00","description":"..."}
   (Vaxt zonası həmişə +04:00 (Bakı) olsun, bitmə vaxtı göstərilməzsə başlanğıcdan 30 dəqiqə sonra qəbul et)
   ƏLAVƏ (Görüşü ləğv etmə): Əgər istifadəçi bir görüşü ləğv etmək istəyirsə, 2-addımlı prosesə tabedir: ADDIM 1-də hansı görüşü ləğv edəcəyini aydınlaşdır, təsdiq soruş; ADDIM 2-də: ACTION:{"type":"cancel_meeting","titleMatch":"görüşün başlığından açar söz","title":"Ləğv edildi","detail":"..."}
   ƏLAVƏ (Hesabat): Əgər istifadəçi hesabat/report istəyirsə ("bu ayın IT ticketlərinin hesabatını hazırla" kimi), 2-addımlı prosesə tabedir: ADDIM 1-də nəyi əhatə edəcəyini (növ, status, müddət) göstər, təsdiq soruş; ADDIM 2-də: ACTION:{"type":"generate_report","title":"Hesabat başlığı","reportType":"leave_request|it_ticket|expense_request və ya boş (hamısı)","reportStatus":"pending|approved|rejected və ya boş (hamısı)","sinceDays":30}
4. Adi cavab üçün sonunda: SOURCE: Sənəd adı — Section X.X
5. Qısa, 2-4 cümlə.
6. Əgər yuxarıda "SON EMAİLLƏR" bölməsi verilibsə, istifadəçi bunları xülasə etməyi istəyirsə, hər emaili 1 sətirdə (kimdən, mövzu) yığcam göstər.
7. Əgər sən REJİM A (adi sual-cavab) ilə cavab verirsənsə VƏ cavabından məntiqli, təbii bir davam əməliyyatı çıxırsa (məs: "Məzuniyyət qaydası" sualından sonra — "istəyirsiniz məzuniyyət sorğusu yaradım?"; "IT Security Policy" sualından sonra — "IT problemi bildirmək istəyirsiniz?"), cavabının SONUNDA (SOURCE-dan da sonra) yeni sətirdə bunu əlavə et: SUGGESTION: qısa təklif mətni (məs: "Məzuniyyət sorğusu yaratmağımı istəyirsiniz?")
   Bunu YALNIZ real, təbii bir davam varsa yaz — hər cavabda məcburi deyil, əksinə əksər sadə faktual suallarda heç bir təklif YAZMA.`;

    // 6) Claude-dan cavab al (söhbət tarixçəsi ilə birlikdə)
    let message;
    try {
      message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: conversationMessages
      });
    } catch (e) {
      console.error('Anthropic API xətası:', e.message);
      return res.status(503).json({ error: 'VUSERA hazırda cavab verə bilmir. Bir neçə saniyə sonra yenidən cəhd edin.' });
    }

    let answerText = message.content.map(b => b.text || '').join('');
    let sourceType = 'answer';
    let createdAction = null;

    if (deniedButRelevant) {
      answerText = 'Bu məlumat üçün icazəniz yoxdur.';
      sourceType = 'denied';
    } else {
      // Cavabda bir "ACTION" (məzuniyyət/ticket/xərc sorğusu) var mı yoxla
      const actionMatch = answerText.match(/ACTION:\s*(\{.*?\})/s);
      if (actionMatch) {
        try {
          const actionData = JSON.parse(actionMatch[1]);
          answerText = answerText.replace(/ACTION:\s*\{.*?\}/s, '').trim();
          sourceType = 'action';
          if (!answerText) answerText = 'Sorğunuz emal edilir...'; // Claude yalnız ACTION yazıbsa, boş qalmasın

          if (actionData.type === 'send_email') {
            // Email göndərmə - approval axınına yox, birbaşa Make.com-a gedir
            const emailResult = await sendEmailViaMake(actionData.to, actionData.subject, actionData.detail || actionData.body || '');
            createdAction = {
              id: 'email-' + Date.now(),
              type: 'send_email',
              title: emailResult.success ? `Email göndərildi: ${actionData.to}` : 'Email göndərilmədi',
              detail: actionData.subject || '',
              status: emailResult.success ? 'sent' : 'failed'
            };
          } else if (actionData.type === 'create_meeting') {
            // Görüş yaratma - approval axınına yox, birbaşa Google Calendar-a gedir
            const meetingResult = await createMeetingViaMake(actionData.title, actionData.startDateTime, actionData.endDateTime, actionData.description || '');
            if (meetingResult.success) {
              await supabase.from('meetings').insert({
                company_id: employee.company_id,
                employee_id: employee.id,
                title: actionData.title,
                start_datetime: actionData.startDateTime,
                end_datetime: actionData.endDateTime,
                calendar_event_id: meetingResult.eventId
              });
            }
            createdAction = {
              id: 'meeting-' + Date.now(),
              type: 'create_meeting',
              title: meetingResult.success ? actionData.title : 'Görüş yaradılmadı',
              detail: actionData.startDateTime || '',
              status: meetingResult.success ? 'created' : 'failed'
            };
          } else if (actionData.type === 'cancel_meeting') {
            // Görüşü ləğv etmə - başlıq/tarixə uyğun aktiv görüşü tapıb Calendar-dan silir
            const { data: matchingMeeting } = await supabase
              .from('meetings')
              .select('*')
              .eq('employee_id', employee.id)
              .eq('status', 'active')
              .ilike('title', `%${actionData.titleMatch || ''}%`)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            if (matchingMeeting && matchingMeeting.calendar_event_id) {
              const cancelResult = await cancelMeetingViaMake(matchingMeeting.calendar_event_id);
              if (cancelResult.success) {
                await supabase.from('meetings').update({ status: 'cancelled' }).eq('id', matchingMeeting.id);
              }
              createdAction = {
                id: 'cancel-' + Date.now(),
                type: 'cancel_meeting',
                title: cancelResult.success ? `Ləğv edildi: ${matchingMeeting.title}` : 'Ləğv edilmədi',
                detail: matchingMeeting.title,
                status: cancelResult.success ? 'cancelled' : 'failed'
              };
            } else {
              createdAction = {
                id: 'cancel-' + Date.now(),
                type: 'cancel_meeting',
                title: 'Görüş tapılmadı',
                detail: 'Uyğun aktiv görüş tapılmadı',
                status: 'failed'
              };
            }
          } else if (actionData.type === 'generate_report') {
            // Hesabat yaratma - real PDF yaradılır, faylların "documents" bucket-inə yüklənir
            const reportResult = await generateReportPdf(employee.company_id, actionData.title, {
              type: actionData.reportType || null,
              status: actionData.reportStatus || null,
              sinceDays: actionData.sinceDays || 30
            });
            createdAction = {
              id: 'report-' + Date.now(),
              type: 'generate_report',
              title: reportResult.success ? actionData.title : 'Hesabat yaradılmadı',
              detail: reportResult.success ? `${reportResult.rowCount} qeyd daxildir` : (reportResult.error || ''),
              status: reportResult.success ? 'created' : 'failed',
              fileUrl: reportResult.url || null
            };
          } else {
          // Real əməliyyat sorğusunu verilənlər bazasına yaz (status: pending, manager təsdiqini gözləyir)
          // 2000 AZN-dən yuxarı xərc sorğuları — Expense Policy-yə əsasən 2 təsdiq (Manager + Finance) tələb edir
          const amountValue = actionData.amount ? parseFloat(actionData.amount) : null;
          const requiredApprovals = (actionData.type === 'expense_request' && amountValue && amountValue > 2000) ? 2 : 1;

          const { data: savedAction, error: actionError } = await supabase
            .from('action_requests')
            .insert({
              company_id: employee.company_id,
              employee_id: employee.id,
              type: actionData.type,
              title: actionData.title,
              detail: actionData.detail,
              priority: actionData.priority || 'normal',
              category: actionData.category || null,
              start_date: actionData.start_date || null,
              end_date: actionData.end_date || null,
              amount: amountValue,
              required_approvals: requiredApprovals,
              status: 'pending'
            })
            .select()
            .single();

          if (!actionError && savedAction) {
            createdAction = {
              id: savedAction.id,
              type: savedAction.type,
              title: savedAction.title,
              detail: savedAction.detail,
              priority: savedAction.priority,
              category: savedAction.category,
              status: savedAction.status
            };

            // Bildiriş kimə getməlidir? Əməliyyatın növünə görə düzgün departamentə yönləndiririk:
            // leave_request -> HR, it_ticket -> IT, expense_request -> Finance (kim yaratsa da fərq etməz)
            // Admin həmişə bildiriş alır.
            const { data: allEmployees } = await supabase
              .from('employees')
              .select('id, role, department_id, departments(name)')
              .eq('company_id', employee.company_id);

            const targetDeptName = actionData.type === 'it_ticket' ? 'IT'
              : actionData.type === 'expense_request' ? 'Finance'
              : actionData.type === 'leave_request' ? 'HR'
              : null;

            const toNotify = (allEmployees || []).filter(m => {
              if (m.id === employee.id) return false;
              if (m.role === 'Admin') return true;
              if (!m.role.includes('Manager')) return false;
              return targetDeptName && m.departments?.name === targetDeptName;
            });

            for (const m of toNotify) {
              createNotification(employee.company_id, m.id,
                `${employee.name} yeni bir ${actionData.type} yaratdı: "${actionData.title}"`, savedAction.id);
            }
          }
          } // send_email deyilsə bloku bağlanır
        } catch (e) {
          console.error('Action parse xətası:', e.message);
        }
      } else {
        // Adi SOURCE mənbəsini təmizlə (cavabın son sətrini saxlayırıq, sadəcə görünüşü təmizləyirik)
        const sourceMatch = answerText.match(/SOURCE:\s*(.+)$/m);
        if (sourceMatch && sourceMatch[1].trim() === 'NONE') sourceType = 'not_found';
      }
    }

    // Follow-up təklifini ayır (varsa) — cavab mətnindən çıxarıb, ayrıca sahədə qaytarırıq
    let suggestion = null;
    const suggestionMatch = answerText.match(/SUGGESTION:\s*(.+)$/m);
    if (suggestionMatch) {
      suggestion = suggestionMatch[1].trim();
      answerText = answerText.replace(/SUGGESTION:\s*.+$/m, '').trim();
    }

    // 7) Söhbəti logla (analitika/dashboard üçün)
    await supabase.from('chat_logs').insert({
      company_id: employee.company_id,
      employee_id: employee.id,
      question,
      answer: answerText,
      source_type: sourceType
    });

    res.json({ answer: answerText, employee: employee.name, role: employee.role, action: createdAction, suggestion });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Sənəd yükləmə: /ingest ----
// Bu, ingest.js skriptinin veb versiyasıdır — kompüterdə heç bir quraşdırma tələb etmir.
// İki üsulla məzmun qəbul edir:
//   1) "content" — sadə mətn (əvvəlki kimi)
//   2) "fileBase64" + "fileType" ('pdf' və ya 'docx') — real fayldan mətn çıxarır
// ---- Qəbz/Faktura oxuma — real şəkil/PDF-dən xərc məlumatını çıxarır ----
// Email paneli üçün — birbaşa inbox-u gətirir (chat axınından kənar)
app.get('/emails', requireAuth, async (req, res) => {
  try {
    const emails = await readRecentEmails();
    res.json({ emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email paneli üçün — birbaşa email göndərir (chat axınından kənar, sadə forma üçün)
app.post('/emails/send', requireAuth, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject və body tələb olunur' });

    // Yalnız real direktoriyadakı ünvanlara icazə ver (uydurma qarşısını almaq üçün)
    const { data: match } = await supabase
      .from('employees')
      .select('id')
      .eq('company_id', req.employee.company_id)
      .eq('email', to)
      .maybeSingle();
    if (!match) return res.status(400).json({ error: 'Bu email ünvanı şirkət direktoriyasında tapılmadı' });

    const result = await sendEmailViaMake(to, subject, body);
    res.json({ success: result.success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/receipts/extract', requireAuth, async (req, res) => {
  try {
    const { fileBase64, fileType } = req.body;
    if (!fileBase64 || !fileType) {
      return res.status(400).json({ error: 'fileBase64 və fileType tələb olunur' });
    }

    const mediaType = fileType === 'pdf' ? 'application/pdf'
      : fileType === 'jpg' || fileType === 'jpeg' ? 'image/jpeg'
      : fileType === 'png' ? 'image/png'
      : null;
    if (!mediaType) return res.status(400).json({ error: 'fileType "pdf", "jpg", "jpeg" və ya "png" olmalıdır' });

    const contentBlockType = fileType === 'pdf' ? 'document' : 'image';

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: contentBlockType, source: { type: 'base64', media_type: mediaType, data: fileBase64 } },
          { type: 'text', text: 'Bu, bir qəbz və ya fakturadır. Aşağıdakı JSON formatında, YALNIZ JSON qaytar (başqa mətn yazma): {"vendor":"satıcı adı","amount":rəqəm,"currency":"AZN/USD/EUR","date":"YYYY-MM-DD","category":"travel|meals|office|other","description":"qısa təsvir"}. Əgər bir sahəni tapa bilmirsənsə, null yaz.' }
        ]
      }]
    });

    const rawText = message.content.map(b => b.text || '').join('');
    const jsonMatch = rawText.match(/\{.*\}/s);
    if (!jsonMatch) return res.status(422).json({ error: 'Qəbzdən məlumat çıxarıla bilmədi' });

    const extracted = JSON.parse(jsonMatch[0]);
    res.json({ success: true, extracted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/ingest', ingestLimiter, requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin sənəd yükləyə bilər' });

    const { companyId, title, docCode, content, fileBase64, fileType, restrictedRoles } = req.body;
    if (!companyId || !title) {
      return res.status(400).json({ error: 'companyId və title tələb olunur' });
    }
    if (!content && !fileBase64) {
      return res.status(400).json({ error: 'content və ya fileBase64 tələb olunur' });
    }

    let extractedText = content;
    let fileUrl = null;

    // Əgər real fayl göndərilibsə, ondan mətni çıxarırıq VƏ faylın özünü də saxlayırıq (açıla bilsin deyə)
    if (fileBase64) {
      const buffer = Buffer.from(fileBase64, 'base64');

      if (fileType === 'pdf') {
        const parsed = await pdfParse(buffer);
        extractedText = parsed.text;
      } else if (fileType === 'docx') {
        const parsed = await mammoth.extractRawText({ buffer });
        extractedText = parsed.value;
      } else {
        return res.status(400).json({ error: 'fileType "pdf" və ya "docx" olmalıdır' });
      }

      // Faylın özünü Supabase Storage-a yükləyirik ki, sonradan "aç" düyməsi işləsin
      const fileName = `${companyId}/${Date.now()}-${title.replace(/[^a-zA-Z0-9._-]/g, '_')}.${fileType}`;
      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(fileName, buffer, {
          contentType: fileType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });

      if (uploadError) {
        console.error('Fayl saxlanma xətası (mətn yenə də indekslənəcək):', uploadError.message);
      } else {
        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
        fileUrl = urlData?.publicUrl || null;
      }
    }

    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ error: 'Sənəddən mətn çıxarıla bilmədi (boş fayl ola bilər)' });
    }

    const restricted = Array.isArray(restrictedRoles) ? restrictedRoles : [];

    const { data: doc, error: docError } = await supabase
      .from('documents')
      .insert({ company_id: companyId, title, doc_code: docCode || null, restricted_to_roles: restricted, file_url: fileUrl })
      .select()
      .single();
    if (docError) throw docError;

    const chunks = chunkDocument(extractedText);
    let count = 0;
    for (const chunk of chunks) {
      const embedding = await getEmbedding(chunk.content);
      const { error: chunkError } = await supabase
        .from('document_chunks')
        .insert({ document_id: doc.id, section_label: chunk.section_label, content: chunk.content, embedding });
      if (chunkError) throw chunkError;
      count++;
    }

    res.json({ success: true, documentId: doc.id, chunksCreated: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Demo köməkçi endpoint-lər ----

app.get('/employees', async (req, res) => {
  const { data, error } = await supabase.from('employees').select('*, departments(name)');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Yeni işçi əlavə etmək (gələcək Admin panel üçün əsas) — AVTOMATIK giriş hesabı da yaradılır
app.post('/employees', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin yeni işçi əlavə edə bilər' });

    const { companyId, departmentId, name, email, role } = req.body;
    if (!companyId || !name || !role || !email) {
      return res.status(400).json({ error: 'companyId, name, email və role tələb olunur' });
    }

    // Müvəqqəti parol yaradırıq — işçi ilk girişdən sonra "Parolu unutmuşam" ilə öz parolunu təyin edə bilər
    const tempPassword = 'Vusera' + Math.random().toString(36).slice(-8) + '!';

    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email, password: tempPassword, email_confirm: true
    });
    if (authError) return res.status(400).json({ error: 'Giriş hesabı yaradıla bilmədi: ' + authError.message });

    const { data, error } = await supabase
      .from('employees')
      .insert({ company_id: companyId, department_id: departmentId || null, name, email, role, auth_user_id: authUser.user.id })
      .select()
      .single();
    if (error) throw error;

    // ---- ONBOARDING WORKFLOW — avtomatik addımlar ----
    // 1) Yeni işçiyə xoş gəldin email-i (giriş məlumatları ilə)
    sendEmailViaMake(
      email,
      `VUSERA-ya xoş gəldiniz, ${name}!`,
      `Salam ${name},\n\nNovaTech Solutions-a xoş gəldiniz! VUSERA Employee Copilot hesabınız hazırdır.\n\nGiriş məlumatlarınız:\nEmail: ${email}\nMüvəqqəti parol: ${tempPassword}\n\nİlk girişdən sonra parolunuzu dəyişməyiniz tövsiyə olunur.\n\nUğurlar!\nVUSERA`
    );

    // 2) IT departamentinə bildiriş (avadanlıq/giriş hazırlığı üçün)
    const { data: itManagers } = await supabase
      .from('employees')
      .select('id, role, departments(name)')
      .eq('company_id', companyId);
    (itManagers || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'IT'))
      .forEach(m => createNotification(companyId, m.id, `👋 Yeni işçi: ${name} (${role}) başladı — noutbuk/giriş hazırlığı lazımdır.`, null));

    // 3) HR departamentinə bildiriş (sənədləşmə üçün)
    (itManagers || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'HR'))
      .forEach(m => createNotification(companyId, m.id, `👋 Yeni işçi qeydə alındı: ${name} (${role}) — HR sənədləşməsi lazımdır.`, null));

    res.json({ success: true, employee: data, temporaryPassword: tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// İşçi məlumatını dəyişmək (ad, rol, departament)
app.put('/employees/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin işçi məlumatını dəyişə bilər' });
    const { name, role, departmentId, status } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (role) updates.role = role;
    if (departmentId) updates.department_id = departmentId;
    if (status) updates.status = status;

    const { data, error } = await supabase
      .from('employees')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, employee: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// İşçini deaktiv etmək (silmək əvəzinə — tarixçəni qorumaq üçün status dəyişdiririk)
app.delete('/employees/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin işçini deaktiv edə bilər' });
    const { data, error } = await supabase
      .from('employees')
      .update({ status: 'inactive' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    // ---- OFFBOARDING WORKFLOW — avtomatik addımlar ----
    // 1) Bütün gələcək aktiv görüşlərini ləğv et
    const { data: activeMeetings } = await supabase
      .from('meetings')
      .select('*')
      .eq('employee_id', data.id)
      .eq('status', 'active');
    for (const m of (activeMeetings || [])) {
      if (m.calendar_event_id) {
        const cancelResult = await cancelMeetingViaMake(m.calendar_event_id);
        if (cancelResult.success) {
          await supabase.from('meetings').update({ status: 'cancelled' }).eq('id', m.id);
        }
      }
    }

    // 2) IT departamentinə bildiriş (avadanlıq geri qaytarılması, giriş bağlanması üçün)
    const { data: allStaff } = await supabase
      .from('employees')
      .select('id, role, departments(name)')
      .eq('company_id', data.company_id);
    (allStaff || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'IT'))
      .forEach(m => createNotification(data.company_id, m.id, `👋 ${data.name} işdən ayrılır — avadanlıq geri qaytarılmalı, giriş bağlanmalıdır.`, null));

    // 3) HR departamentinə bildiriş (son sənədləşmə üçün)
    (allStaff || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'HR'))
      .forEach(m => createNotification(data.company_id, m.id, `👋 ${data.name} işdən ayrılır — son hesablaşma/sənədləşmə lazımdır.`, null));

    // 4) Gözləyən (pending) sorğuları yoxla — Admin-ə xəbərdarlıq et ki, unudulmasın
    const { data: pendingReqs } = await supabase
      .from('action_requests')
      .select('id, type, title')
      .eq('employee_id', data.id)
      .eq('status', 'pending');
    if (pendingReqs && pendingReqs.length > 0) {
      (allStaff || []).filter(m => m.role === 'Admin')
        .forEach(m => createNotification(data.company_id, m.id,
          `⚠️ ${data.name} işdən ayrılır, amma ${pendingReqs.length} gözləyən sorğusu var (həll edilməmiş) — nəzərdən keçirin.`, null));
    }

    res.json({ success: true, employee: data, meetingsCancelled: (activeMeetings || []).length, pendingRequestsFlagged: (pendingReqs || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Yeni şirkət (workspace) yaratmaq — hər müştəri üçün ayrıca mühit
app.post('/companies', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name tələb olunur' });
    const { data, error } = await supabase.from('companies').insert({ name }).select().single();
    if (error) throw error;
    res.json({ success: true, company: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Şirkət üçün departament yaratmaq
app.post('/departments', async (req, res) => {
  try {
    const { companyId, name } = req.body;
    if (!companyId || !name) return res.status(400).json({ error: 'companyId və name tələb olunur' });
    const { data, error } = await supabase
      .from('departments')
      .insert({ company_id: companyId, name })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, department: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Şirkətin departamentlərini siyahı kimi gətirmək (admin panel üçün)
app.get('/departments/:companyId', async (req, res) => {
  const { data, error } = await supabase
    .from('departments')
    .select('id, name')
    .eq('company_id', req.params.companyId)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Şirkət sənədləri
app.get('/documents/:companyId', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, doc_code, restricted_to_roles, uploaded_at, file_url')
    .eq('company_id', req.params.companyId)
    .order('uploaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Sənəd məlumatını yeniləmək (ad, kod, icazələr — məzmunu dəyişmək üçün silib yenidən yükləyin)
app.put('/documents/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin sənədi dəyişə bilər' });
    const { title, docCode, restrictedRoles } = req.body;
    const updates = {};
    if (title) updates.title = title;
    if (docCode !== undefined) updates.doc_code = docCode;
    if (Array.isArray(restrictedRoles)) updates.restricted_to_roles = restrictedRoles;

    const { data, error } = await supabase
      .from('documents')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, document: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sənədi tamamilə silmək (bütün parçaları/embedding-ləri də silinir — cascade)
app.delete('/documents/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin sənədi silə bilər' });
    const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Sənəd və bütün parçaları silindi' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit Log — kim, nə vaxt, nə edib (söhbətlər + əməliyyatlar birləşdirilmiş xronoloji siyahı)
app.get('/audit-log/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin audit logu görə bilər' });
    const limit = parseInt(req.query.limit) || 50;

    const [{ data: chats, error: chatsError }, { data: actions, error: actionsError }] = await Promise.all([
      supabase
        .from('chat_logs')
        .select('id, created_at, question, source_type, employees(name, role)')
        .eq('company_id', req.params.companyId)
        .order('created_at', { ascending: false })
        .limit(limit),
      supabase
        .from('action_requests')
        .select('id, created_at, type, title, status, approved_at, employees!employee_id(name, role), approver:employees!approved_by(name)')
        .eq('company_id', req.params.companyId)
        .order('created_at', { ascending: false })
        .limit(limit)
    ]);
    if (chatsError) throw chatsError;
    if (actionsError) throw actionsError;

    const events = [];

    for (const c of chats || []) {
      events.push({
        timestamp: c.created_at,
        actor: c.employees?.name || 'Naməlum',
        actorRole: c.employees?.role,
        eventType: 'question',
        description: `"${c.question}" — nəticə: ${c.source_type}`
      });
    }

    for (const a of actions || []) {
      events.push({
        timestamp: a.created_at,
        actor: a.employees?.name || 'Naməlum',
        actorRole: a.employees?.role,
        eventType: 'action_created',
        description: `${a.type} yaratdı: "${a.title}" (status: ${a.status})`
      });
      if (a.approved_at) {
        events.push({
          timestamp: a.approved_at,
          actor: a.approver?.name || 'Naməlum',
          eventType: a.status === 'approved' ? 'action_approved' : 'action_rejected',
          description: `"${a.title}" sorğusunu ${a.status === 'approved' ? 'təsdiqlədi' : 'rədd etdi'}`
        });
      }
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(events.slice(0, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// İşçinin ÖZ sorğularını göstərir (URL-dəki ID-yə deyil, təsdiqlənmiş tokenə əsaslanır)
app.get('/actions/me', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('action_requests')
    .select('*')
    .eq('employee_id', req.employee.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Manager təsdiqi: /actions/:id/approve və /actions/:id/reject ----

function isManagerRole(role) {
  return role.includes('Manager') || role === 'Admin';
}

// Bu manager, bu konkret sorğunu təsdiqləməyə/rəddə səlahiyyətlidirmi? (Admin həmişə bəli)
// Qayda: leave_request -> HR, it_ticket -> IT, expense_request -> Finance (kim yaratsa da fərq etməz)
async function canManageAction(approver, action) {
  if (approver.role === 'Admin') return true;

  const targetDept = action.type === 'it_ticket' ? 'IT'
    : action.type === 'expense_request' ? 'Finance'
    : action.type === 'leave_request' ? 'HR'
    : null;
  if (!targetDept) return false;

  if (isManagerRole(approver.role)) {
    const { data: dept } = await supabase.from('departments').select('name').eq('id', approver.department_id).single();
    if (dept?.name === targetDept) return true;
  }

  // Delegation yoxlanışı — bu şəxsə müvəqqəti olaraq bu departamentin təsdiq səlahiyyəti verilibmi?
  const today = new Date().toISOString().slice(0, 10);
  const { data: delegation } = await supabase
    .from('approval_delegations')
    .select('id')
    .eq('delegate_id', approver.id)
    .eq('department_name', targetDept)
    .lte('start_date', today)
    .gte('end_date', today)
    .maybeSingle();

  return !!delegation;
}

app.post('/actions/:id/approve', requireAuth, async (req, res) => {
  try {
    const approver = req.employee;

    const { data: actionCheck, error: actionCheckError } = await supabase
      .from('action_requests').select('*').eq('id', req.params.id).single();
    if (actionCheckError || !actionCheck) return res.status(404).json({ error: 'Sorğu tapılmadı' });

    if (actionCheck.status !== 'pending') {
      return res.status(400).json({ error: 'Bu sorğu artıq həll olunub' });
    }

    const allowed = await canManageAction(approver, actionCheck);
    if (!allowed) {
      return res.status(403).json({ error: 'Bu sorğunu təsdiqləmək üçün icazəniz yoxdur (səlahiyyətli departament deyilsiniz)' });
    }

    // Bu approver artıq təsdiqləyibsə, təkrar sayılmasın
    const { data: existingApproval } = await supabase
      .from('action_approvals')
      .select('id')
      .eq('action_request_id', req.params.id)
      .eq('approver_id', approver.id)
      .maybeSingle();
    if (existingApproval) {
      return res.status(400).json({ error: 'Siz bu sorğunu artıq təsdiqləmisiniz' });
    }

    // Bu təsdiqi qeydə al
    await supabase.from('action_approvals').insert({
      action_request_id: req.params.id, approver_id: approver.id, approver_role: approver.role
    });

    // Neçə fərqli təsdiq toplanıb, yoxla
    const { count: approvalsCount } = await supabase
      .from('action_approvals')
      .select('*', { count: 'exact', head: true })
      .eq('action_request_id', req.params.id);

    const requiredApprovals = actionCheck.required_approvals || 1;
    const isFullyApproved = approvalsCount >= requiredApprovals;

    const { data: updated, error: updateError } = await supabase
      .from('action_requests')
      .update({
        status: isFullyApproved ? 'approved' : 'pending',
        approved_by: approver.id,
        approved_at: isFullyApproved ? new Date().toISOString() : null
      })
      .eq('id', req.params.id)
      .select('*, employees!employee_id(name, company_id)')
      .single();
    if (updateError) throw updateError;

    if (isFullyApproved) {
      // Əgər bu bir məzuniyyət sorğusudursa, Google Calendar-a yaz
      if (updated.type === 'leave_request') {
        callVuseraRouter('leave_approved', {
          employeeName: updated.employees?.name,
          title: updated.title,
          detail: updated.detail,
          approvedBy: approver.name,
          startDate: updated.start_date,
          endDate: updated.end_date
        });
      }
      createNotification(updated.employees.company_id, updated.employee_id,
        `"${updated.title}" sorğunuz TAM təsdiqləndi ✅`, updated.id);
    } else {
      // Qismən təsdiq — işçiyə və qalan təsdiqləyicilərə məlumat ver
      createNotification(updated.employees.company_id, updated.employee_id,
        `"${updated.title}" sorğunuz ${approvalsCount}/${requiredApprovals} təsdiq aldı — daha bir təsdiq gözlənilir.`, updated.id);
    }

    res.json({ success: true, action: updated, approvalsCount, requiredApprovals, isFullyApproved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/actions/:id/reject', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const approver = req.employee;

    const { data: actionCheck, error: actionCheckError } = await supabase
      .from('action_requests').select('type, employee_id').eq('id', req.params.id).single();
    if (actionCheckError || !actionCheck) return res.status(404).json({ error: 'Sorğu tapılmadı' });

    const allowed = await canManageAction(approver, actionCheck);
    if (!allowed) {
      return res.status(403).json({ error: 'Bu sorğunu rədd etmək üçün icazəniz yoxdur (səlahiyyətli departament deyilsiniz)' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('action_requests')
      .update({ status: 'rejected', approved_by: approver.id, approved_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw updateError;

    createNotification(updated.company_id, updated.employee_id,
      `"${updated.title}" sorğunuz rədd edildi.${reason ? ' Səbəb: ' + reason : ''}`, updated.id);

    res.json({ success: true, action: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Şirkətin "pending" (gözləyən) sorğularını göstərir — Manager Dashboard üçün əsasdır.
// Icazə qaydası: Admin -> bütün şirkəti görür.
//   leave_request/expense_request-in növündən asılı olmayaraq, DÜZGÜN departamentin manageri görməlidir:
//   - leave_request -> işçinin ÖZ departamentinin manageri (öz komandan)
//   - it_ticket -> HƏMİŞƏ IT departamentinin manageri (kim yaratsa da fərq etməz)
//   - expense_request -> HƏMİŞƏ Finance departamentinin manageri
app.get('/pending-actions/:companyId', requireAuth, async (req, res) => {
  try {
    const viewer = req.employee;
    const today = new Date().toISOString().slice(0, 10);

    // Bu istifadəçinin aktiv delegation-ları (müvəqqəti səlahiyyətləri) var mı?
    const { data: myDelegations } = await supabase
      .from('approval_delegations')
      .select('department_name')
      .eq('delegate_id', viewer.id)
      .lte('start_date', today)
      .gte('end_date', today);
    const delegatedDepts = (myDelegations || []).map(d => d.department_name);

    if (!isManagerRole(viewer.role) && viewer.role !== 'Admin' && delegatedDepts.length === 0) {
      return res.status(403).json({ error: 'Yalnız manager/admin rolları (və ya delegation almış şəxslər) gözləyən sorğuları görə bilər' });
    }

    const { data, error } = await supabase
      .from('action_requests')
      .select('*, employees!employee_id(name, role, department_id)')
      .eq('company_id', req.params.companyId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;

    let filtered;
    if (viewer.role === 'Admin') {
      filtered = data; // Admin hər şeyi görür
    } else {
      const viewerDeptName = viewer.departments?.name;
      filtered = data.filter(action => {
        const actionDept = action.type === 'it_ticket' ? 'IT' : action.type === 'expense_request' ? 'Finance' : action.type === 'leave_request' ? 'HR' : null;
        if (!actionDept) return false;
        return viewerDeptName === actionDept || delegatedDepts.includes(actionDept);
      });
    }

    // Hər sorğu üçün: neçə təsdiq alınıb, bu izləyici artıq təsdiqləyibmi
    const ids = filtered.map(a => a.id);
    const { data: allApprovals } = ids.length > 0
      ? await supabase.from('action_approvals').select('action_request_id, approver_id').in('action_request_id', ids)
      : { data: [] };

    const enriched = filtered.map(a => {
      const approvalsForThis = (allApprovals || []).filter(ap => ap.action_request_id === a.id);
      return {
        ...a,
        approvalsCount: approvalsForThis.length,
        requiredApprovals: a.required_approvals || 1,
        viewerAlreadyApproved: approvalsForThis.some(ap => ap.approver_id === viewer.id)
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bildirişlər — istifadəçinin ÖZ bildirişlərini gətirir (tokendən müəyyən edilir)
app.get('/notifications/me', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('employee_id', req.employee.id)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Bir bildirişi "oxunmuş" kimi işarələmək
app.post('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, notification: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Şirkət üçün ümumi statistika — Admin Dashboard-un əsası
app.get('/dashboard/:companyId', requireAuth, async (req, res) => {  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin dashboard-u görə bilər' });
    const companyId = req.params.companyId;

    const [
      { count: employeeCount },
      { count: aiConversations },
      { count: requestCount },
      { count: pendingRequests },
      { count: itTickets },
      { count: expenses }
    ] = await Promise.all([
      supabase.from('employees').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
      supabase.from('chat_logs').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'pending'),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('type', 'it_ticket'),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('type', 'expense_request')
    ]);

    res.json({ employeeCount, aiConversations, requestCount, pendingRequests, itTickets, expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Advanced Analytics — Top Questions, Department breakdown, Ən aktiv işçilər ----
// ---- Approval Delegation (Granular RBAC) — Admin başqasına müvəqqəti təsdiq səlahiyyəti verə bilər ----
app.post('/delegations', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin delegation təyin edə bilər' });
    const { delegateId, departmentName, startDate, endDate } = req.body;
    if (!delegateId || !departmentName || !startDate || !endDate) {
      return res.status(400).json({ error: 'delegateId, departmentName, startDate, endDate tələb olunur' });
    }
    if (!['IT', 'HR', 'Finance'].includes(departmentName)) {
      return res.status(400).json({ error: 'departmentName "IT", "HR" və ya "Finance" olmalıdır' });
    }

    const { data, error } = await supabase
      .from('approval_delegations')
      .insert({
        company_id: req.employee.company_id,
        delegate_id: delegateId,
        department_name: departmentName,
        start_date: startDate,
        end_date: endDate,
        created_by: req.employee.id
      })
      .select('*, employees!delegate_id(name, role)')
      .single();
    if (error) throw error;

    createNotification(req.employee.company_id, delegateId,
      `🔑 Sizə ${startDate} — ${endDate} tarixləri üçün "${departmentName}" sorğularını təsdiqləmə səlahiyyəti verildi.`, null);

    res.json({ success: true, delegation: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/delegations/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin görə bilər' });
    const { data, error } = await supabase
      .from('approval_delegations')
      .select('*, employees!delegate_id(name, role)')
      .eq('company_id', req.params.companyId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/delegations/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin silə bilər' });
    const { error } = await supabase.from('approval_delegations').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/analytics/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'Yalnız Admin analitikanı görə bilər' });
    const companyId = req.params.companyId;

    // 1) Top Questions — ən çox təkrarlanan (eyni mətnli) suallar
    const { data: allQuestions } = await supabase
      .from('chat_logs')
      .select('question')
      .eq('company_id', companyId);

    const qCounts = {};
    (allQuestions || []).forEach(q => {
      const norm = (q.question || '').trim().toLowerCase().replace(/[?!.,]/g, '');
      if (!norm) return;
      qCounts[norm] = (qCounts[norm] || 0) + 1;
    });
    const topQuestions = Object.entries(qCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([question, count]) => ({ question, count }));

    // 2) Departament üzrə sorğu sayı
    const { data: allRequests } = await supabase
      .from('action_requests')
      .select('type, status, employees!employee_id(departments(name))')
      .eq('company_id', companyId);

    const deptCounts = {};
    (allRequests || []).forEach(r => {
      const dept = r.employees?.departments?.name || 'Naməlum';
      deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    });
    const requestsByDepartment = Object.entries(deptCounts).map(([department, count]) => ({ department, count }));

    // 3) Növ üzrə sorğu sayı (leave/it/expense)
    const typeCounts = {};
    (allRequests || []).forEach(r => { typeCounts[r.type] = (typeCounts[r.type] || 0) + 1; });
    const requestsByType = Object.entries(typeCounts).map(([type, count]) => ({ type, count }));

    // 4) Status üzrə sorğu sayı
    const statusCounts = {};
    (allRequests || []).forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const requestsByStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

    // 5) Ən aktiv işçilər (ən çox sual verən, ilk 5)
    const { data: allChats } = await supabase
      .from('chat_logs')
      .select('employee_id, employees!employee_id(name)')
      .eq('company_id', companyId);
    const empCounts = {};
    (allChats || []).forEach(c => {
      const name = c.employees?.name || 'Naməlum';
      empCounts[name] = (empCounts[name] || 0) + 1;
    });
    const mostActiveEmployees = Object.entries(empCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    res.json({ topQuestions, requestsByDepartment, requestsByType, requestsByStatus, mostActiveEmployees });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Proaktiv AI: Gözləyən sorğular üçün xatırlatmalar ----
// Bu endpoint xaricdən (Make.com-un "scheduled" — gündəlik) çağırılmalıdır.
// 2 gündən çox gözləyən sorğular üçün: manager-ə "hələ baxılmayıb" xatırlatması,
// işçiyə isə "sorğunuz hələ gözləyir" məlumatı göndərir.
app.post('/proactive/check-reminders', async (req, res) => {
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const { data: staleRequests, error } = await supabase
      .from('action_requests')
      .select('*, employees!employee_id(id, name, company_id, department_id)')
      .eq('status', 'pending')
      .lt('created_at', twoDaysAgo);
    if (error) throw error;

    let remindersSent = 0;

    for (const reqItem of staleRequests || []) {
      const emp = reqItem.employees;
      if (!emp) continue;

      await createNotification(emp.company_id, emp.id,
        `⏳ Xatırlatma: "${reqItem.title}" sorğunuz hələ gözləyir (${Math.floor((Date.now() - new Date(reqItem.created_at)) / (24*60*60*1000))} gündür).`,
        reqItem.id);

      const targetDept = reqItem.type === 'it_ticket' ? 'IT'
        : reqItem.type === 'expense_request' ? 'Finance'
        : reqItem.type === 'leave_request' ? 'HR'
        : null;

      if (targetDept) {
        const { data: managers } = await supabase
          .from('employees')
          .select('id, role, departments(name)')
          .eq('company_id', emp.company_id);

        const relevantManagers = (managers || []).filter(m =>
          m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === targetDept)
        );

        for (const m of relevantManagers) {
          await createNotification(emp.company_id, m.id,
            `⏳ Xatırlatma: ${emp.name}-in "${reqItem.title}" sorğusu 2+ gündür gözləyir, hələ baxılmayıb.`,
            reqItem.id);
        }
      }

      remindersSent++;
    }

    // ---- Görüş xatırlatmaları — bugün olacaq görüşlər üçün səhər xəbərdarlığı ----
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const { data: todaysMeetings } = await supabase
      .from('meetings')
      .select('*, employees!employee_id(id, name, company_id)')
      .eq('status', 'active')
      .gte('start_datetime', todayStart)
      .lt('start_datetime', todayEnd);

    let meetingRemindersSent = 0;
    for (const m of todaysMeetings || []) {
      const emp = m.employees;
      if (!emp) continue;
      const time = new Date(m.start_datetime).toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' });
      await createNotification(emp.company_id, emp.id,
        `📅 Xatırlatma: bugün saat ${time}-da "${m.title}" görüşünüz var.`, null);
      meetingRemindersSent++;
    }

    // ---- IT Auto-Escalation — yüksək prioritetli, 4+ saatdır həll olunmayan IT ticket-ləri Admin-ə yüksəldir ----
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    const { data: staleHighPriorityTickets } = await supabase
      .from('action_requests')
      .select('*, employees!employee_id(name, company_id)')
      .eq('type', 'it_ticket')
      .eq('priority', 'high')
      .eq('status', 'pending')
      .eq('escalated', false)
      .lt('created_at', fourHoursAgo);

    let escalatedCount = 0;
    for (const ticket of staleHighPriorityTickets || []) {
      const emp = ticket.employees;
      if (!emp) continue;

      const { data: admins } = await supabase
        .from('employees')
        .select('id')
        .eq('company_id', emp.company_id)
        .eq('role', 'Admin');

      for (const admin of admins || []) {
        await createNotification(emp.company_id, admin.id,
          `🚨 YÜKSƏLDİLDİ: "${ticket.title}" (${emp.name}) — yüksək prioritetli IT problemi 4+ saatdır həll olunmayıb!`,
          ticket.id);
      }

      await supabase.from('action_requests').update({ escalated: true }).eq('id', ticket.id);
      escalatedCount++;
    }

    res.json({ success: true, remindersSent, meetingRemindersSent, escalatedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Naməlum yol (route) üçün aydın xəta — DİQQƏT: bu, həmişə BÜTÜN route-lardan SONRA olmalıdır!
app.use((req, res) => {
  res.status(404).json({ error: 'Bu ünvan tapılmadı' });
});

// Ən son, gözlənilməz bütün xətalar üçün ümumi tutucu (server çökməsin deyə)
app.use((err, req, res, next) => {
  console.error('Gözlənilməz xəta:', err);
  res.status(500).json({ error: 'Daxili server xətası baş verdi' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 VUSERA Copilot API ${PORT} portunda işləyir`));

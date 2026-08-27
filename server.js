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
import { supabase, getEmbedding, chunkDocument } from './lib.js';

const app = express();
app.use(cors());
app.use(express.json());

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

// Make.com-a "webhook" bildirişi göndərir (məsələn təsdiqlənən məzuniyyəti Google Calendar-a yazmaq üçün).
// Bu, "fire-and-forget"dir — uğursuz olsa belə əsas cavabı gecikdirmir və ya pozmur.
async function notifyMake(payload) {
  if (!process.env.MAKE_WEBHOOK_URL) return; // qurulmayıbsa, sakitcə keç
  try {
    await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Make.com bildirişi göndərilmədi:', e.message);
  }
}

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

app.post('/ask', askLimiter, async (req, res) => {
  try {
    const { employeeId, question } = req.body;
    if (!employeeId || !question) {
      return res.status(400).json({ error: 'employeeId və question tələb olunur' });
    }
    if (!isValidUUID(employeeId)) {
      return res.status(400).json({ error: 'employeeId düzgün formatda deyil' });
    }
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

Aşağıda bu sualla əlaqəli, sistemin indi tapdığı sənəd parçaları var (əgər söhbətin əvvəlki hissəsi varsa, onu da nəzərə al — məsələn "bəs neçə gün?" kimi davam sualları):
${contextText || '(bu sual üçün uyğun yeni sənəd tapılmadı — əvvəlki söhbətə əsaslana bilərsən, əks halda tapılmadığını de)'}

QAYDALAR:
1. Yalnız yuxarıdakı parçalara əsaslan, uydurma.
2. Əgər kontekst boşdursa və ya sual bununla əlaqəli deyilsə, "Bu məlumat mövcud bilik bazasında tapılmadı" de.
3. Əgər istifadəçi bir əməliyyat istəyirsə (məzuniyyət/xərc/IT problemi), lazımi detalları topla və əməliyyatı təsdiqlə, sonunda: ACTION:{"type":"leave_request|it_ticket|expense_request","title":"...","detail":"...","priority":"low|normal|high","category":"..."}
   - leave_request üçün category: "annual" | "sick" | "unpaid" | "emergency"
   - it_ticket üçün category: "hardware" | "software" | "access" | "network"; priority: problemi ciddiliyinə görə seç (mes: "işləmir" = high, "yavaşdır" = normal)
   - expense_request üçün category: "travel" | "meals" | "office" | "other"
4. Adi cavab üçün sonunda: SOURCE: Sənəd adı — Section X.X
5. Qısa, 2-4 cümlə.`;

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
      const actionMatch = answerText.match(/ACTION:\s*(\{.+\})\s*$/s);
      if (actionMatch) {
        try {
          const actionData = JSON.parse(actionMatch[1]);
          answerText = answerText.replace(/ACTION:\s*\{.+\}\s*$/s, '').trim();
          sourceType = 'action';

          // Real əməliyyat sorğusunu verilənlər bazasına yaz (status: pending, manager təsdiqini gözləyir)
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
        } catch (e) {
          console.error('Action parse xətası:', e.message);
        }
      } else {
        // Adi SOURCE mənbəsini təmizlə (cavabın son sətrini saxlayırıq, sadəcə görünüşü təmizləyirik)
        const sourceMatch = answerText.match(/SOURCE:\s*(.+)$/m);
        if (sourceMatch && sourceMatch[1].trim() === 'NONE') sourceType = 'not_found';
      }
    }

    // 7) Söhbəti logla (analitika/dashboard üçün)
    await supabase.from('chat_logs').insert({
      company_id: employee.company_id,
      employee_id: employee.id,
      question,
      answer: answerText,
      source_type: sourceType
    });

    res.json({ answer: answerText, employee: employee.name, role: employee.role, action: createdAction });

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
app.post('/ingest', ingestLimiter, async (req, res) => {
  try {
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

// Yeni işçi əlavə etmək (gələcək Admin panel üçün əsas)
app.post('/employees', async (req, res) => {
  try {
    const { companyId, departmentId, name, email, role } = req.body;
    if (!companyId || !name || !role) {
      return res.status(400).json({ error: 'companyId, name və role tələb olunur' });
    }
    const { data, error } = await supabase
      .from('employees')
      .insert({ company_id: companyId, department_id: departmentId || null, name, email: email || null, role })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, employee: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// İşçi məlumatını dəyişmək (ad, rol, departament)
app.put('/employees/:id', async (req, res) => {
  try {
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
app.delete('/employees/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .update({ status: 'inactive' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, employee: data });
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
app.put('/documents/:id', async (req, res) => {
  try {
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
app.delete('/documents/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Sənəd və bütün parçaları silindi' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit Log — kim, nə vaxt, nə edib (söhbətlər + əməliyyatlar birləşdirilmiş xronoloji siyahı)
app.get('/audit-log/:companyId', async (req, res) => {
  try {
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

app.get('/actions/:employeeId', async (req, res) => {
  const { data, error } = await supabase
    .from('action_requests')
    .select('*')
    .eq('employee_id', req.params.employeeId)
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
  if (!isManagerRole(approver.role)) return false;

  const targetDept = action.type === 'it_ticket' ? 'IT'
    : action.type === 'expense_request' ? 'Finance'
    : action.type === 'leave_request' ? 'HR'
    : null;
  if (!targetDept) return false;

  const { data: dept } = await supabase.from('departments').select('name').eq('id', approver.department_id).single();
  return dept?.name === targetDept;
}

app.post('/actions/:id/approve', async (req, res) => {
  try {
    const { approverId } = req.body;
    if (!approverId) return res.status(400).json({ error: 'approverId tələb olunur' });

    const { data: approver, error: approverError } = await supabase
      .from('employees').select('*').eq('id', approverId).single();
    if (approverError || !approver) return res.status(404).json({ error: 'Təsdiqləyici tapılmadı' });

    const { data: actionCheck, error: actionCheckError } = await supabase
      .from('action_requests').select('type, employee_id').eq('id', req.params.id).single();
    if (actionCheckError || !actionCheck) return res.status(404).json({ error: 'Sorğu tapılmadı' });

    const allowed = await canManageAction(approver, actionCheck);
    if (!allowed) {
      return res.status(403).json({ error: 'Bu sorğunu təsdiqləmək üçün icazəniz yoxdur (səlahiyyətli departament deyilsiniz)' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('action_requests')
      .update({ status: 'approved', approved_by: approverId, approved_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, employees!employee_id(name)')
      .single();
    if (updateError) throw updateError;

    // Əgər bu bir məzuniyyət sorğusudursa, Make.com-a bildiriş göndər (məs: Google Calendar-a yazmaq üçün)
    if (updated.type === 'leave_request') {
      notifyMake({
        event: 'leave_request_approved',
        employeeName: updated.employees?.name,
        title: updated.title,
        detail: updated.detail,
        approvedBy: approver.name
      });
    }

    // İşçiyə bildiriş göndər
    createNotification(updated.company_id, updated.employee_id,
      `"${updated.title}" sorğunuz təsdiqləndi ✅`, updated.id);

    res.json({ success: true, action: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/actions/:id/reject', async (req, res) => {
  try {
    const { approverId, reason } = req.body;
    if (!approverId) return res.status(400).json({ error: 'approverId tələb olunur' });

    const { data: approver, error: approverError } = await supabase
      .from('employees').select('*').eq('id', approverId).single();
    if (approverError || !approver) return res.status(404).json({ error: 'Təsdiqləyici tapılmadı' });

    const { data: actionCheck, error: actionCheckError } = await supabase
      .from('action_requests').select('type, employee_id').eq('id', req.params.id).single();
    if (actionCheckError || !actionCheck) return res.status(404).json({ error: 'Sorğu tapılmadı' });

    const allowed = await canManageAction(approver, actionCheck);
    if (!allowed) {
      return res.status(403).json({ error: 'Bu sorğunu rədd etmək üçün icazəniz yoxdur (səlahiyyətli departament deyilsiniz)' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('action_requests')
      .update({ status: 'rejected', approved_by: approverId, approved_at: new Date().toISOString(), rejection_reason: reason || null })
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
app.get('/pending-actions/:companyId', async (req, res) => {
  try {
    const { viewerId } = req.query;
    if (!viewerId) return res.status(400).json({ error: 'viewerId (?viewerId=...) tələb olunur' });

    const { data: viewer, error: viewerError } = await supabase
      .from('employees').select('*, departments(name)').eq('id', viewerId).single();
    if (viewerError || !viewer) return res.status(404).json({ error: 'İstifadəçi tapılmadı' });

    if (!isManagerRole(viewer.role)) {
      return res.status(403).json({ error: 'Yalnız manager/admin rolları gözləyən sorğuları görə bilər' });
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
        if (action.type === 'it_ticket') return viewerDeptName === 'IT';
        if (action.type === 'expense_request') return viewerDeptName === 'Finance';
        if (action.type === 'leave_request') return viewerDeptName === 'HR';
        return false;
      });
    }

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bildirişlər — istifadəçinin bütün bildirişlərini gətirir (yenilər əvvəldə)
app.get('/notifications/:employeeId', async (req, res) => {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('employee_id', req.params.employeeId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Bir bildirişi "oxunmuş" kimi işarələmək
app.post('/notifications/:id/read', async (req, res) => {
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
app.get('/dashboard/:companyId', async (req, res) => {
  try {
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

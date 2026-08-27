// server.js — VUSERA Employee Copilot API
//
// Endpoint-lər:
//   POST /ask        — işçi sual verir, RAG ilə cavab alır (mənbə/xülasə/action ilə)
//   GET  /employees   — demo üçün işçi siyahısı
//   GET  /actions/:employeeId — işçinin yaratdığı sorğular

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { supabase, getEmbedding, chunkDocument } from './lib.js';

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

app.post('/ask', async (req, res) => {
  try {
    const { employeeId, question } = req.body;
    if (!employeeId || !question) {
      return res.status(400).json({ error: 'employeeId və question tələb olunur' });
    }

    // 1) İşçini tap (rol, şirkət)
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, departments(name)')
      .eq('id', employeeId)
      .single();
    if (empError || !employee) return res.status(404).json({ error: 'İşçi tapılmadı' });

    // 2) Sualın embedding-ini yarat
    const queryEmbedding = await getEmbedding(question);

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
3. Əgər istifadəçi bir əməliyyat istəyirsə (məzuniyyət/xərc/IT problemi), lazımi detalları topla və əməliyyatı təsdiqlə, sonunda: ACTION:{"type":"leave_request|it_ticket|expense_request","title":"...","detail":"..."}
4. Adi cavab üçün sonunda: SOURCE: Sənəd adı — Section X.X
5. Qısa, 2-4 cümlə.`;

    // 6) Claude-dan cavab al (söhbət tarixçəsi ilə birlikdə)
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: conversationMessages
    });

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
              status: savedAction.status
            };
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
// Make.com-dan (yaxud hər hansı HTTP aləti ilə) POST sorğusu ilə çağırıla bilər.
app.post('/ingest', async (req, res) => {
  try {
    const { companyId, title, docCode, content, restrictedRoles } = req.body;
    if (!companyId || !title || !content) {
      return res.status(400).json({ error: 'companyId, title və content tələb olunur' });
    }

    const restricted = Array.isArray(restrictedRoles) ? restrictedRoles : [];

    const { data: doc, error: docError } = await supabase
      .from('documents')
      .insert({ company_id: companyId, title, doc_code: docCode || null, restricted_to_roles: restricted })
      .select()
      .single();
    if (docError) throw docError;

    const chunks = chunkDocument(content);
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

app.post('/actions/:id/approve', async (req, res) => {
  try {
    const { approverId } = req.body;
    if (!approverId) return res.status(400).json({ error: 'approverId tələb olunur' });

    const { data: approver, error: approverError } = await supabase
      .from('employees').select('*').eq('id', approverId).single();
    if (approverError || !approver) return res.status(404).json({ error: 'Təsdiqləyici tapılmadı' });
    if (!isManagerRole(approver.role)) {
      return res.status(403).json({ error: 'Yalnız manager/admin rolları təsdiqləyə bilər' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('action_requests')
      .update({ status: 'approved', approved_by: approverId, approved_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw updateError;

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
    if (!isManagerRole(approver.role)) {
      return res.status(403).json({ error: 'Yalnız manager/admin rolları rədd edə bilər' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('action_requests')
      .update({ status: 'rejected', approved_by: approverId, approved_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw updateError;

    res.json({ success: true, action: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Şirkətin "pending" (gözləyən) sorğularını göstərir — Manager Dashboard üçün əsasdır.
// Icazə qaydası: Admin -> bütün şirkəti görür. Manager -> yalnız öz departamentini görür. Employee -> görə bilməz.
app.get('/pending-actions/:companyId', async (req, res) => {
  try {
    const { viewerId } = req.query;
    if (!viewerId) return res.status(400).json({ error: 'viewerId (?viewerId=...) tələb olunur' });

    const { data: viewer, error: viewerError } = await supabase
      .from('employees').select('*').eq('id', viewerId).single();
    if (viewerError || !viewer) return res.status(404).json({ error: 'İstifadəçi tapılmadı' });

    if (!isManagerRole(viewer.role)) {
      return res.status(403).json({ error: 'Yalnız manager/admin rolları gözləyən sorğuları görə bilər' });
    }

    let query = supabase
      .from('action_requests')
      .select('*, employees(name, role, department_id)')
      .eq('company_id', req.params.companyId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    // Admin hamısını görür. Manager isə yalnız öz departamentindəki işçilərin sorğularını görür.
    const filtered = viewer.role === 'Admin'
      ? data
      : data.filter(action => action.employees?.department_id === viewer.department_id);

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 VUSERA Copilot API ${PORT} portunda işləyir`));

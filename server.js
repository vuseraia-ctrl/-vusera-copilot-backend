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

Aşağıda YALNIZ bu sualla əlaqəli, sistemin tapdığı sənəd parçaları var:
${contextText || '(heç bir uyğun sənəd tapılmadı)'}

QAYDALAR:
1. Yalnız yuxarıdakı parçalara əsaslan, uydurma.
2. Əgər kontekst boşdursa və ya sual bununla əlaqəli deyilsə, "Bu məlumat mövcud bilik bazasında tapılmadı" de.
3. Əgər istifadəçi bir əməliyyat istəyirsə (məzuniyyət/xərc/IT problemi), lazımi detalları topla və əməliyyatı təsdiqlə, sonunda: ACTION:{"type":"leave_request|it_ticket|expense_request","title":"...","detail":"..."}
4. Adi cavab üçün sonunda: SOURCE: Sənəd adı — Section X.X
5. Qısa, 2-4 cümlə.`;

    // 6) Claude-dan cavab al
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }]
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

          // Real əməliyyat sorğusunu verilənlər bazasına yaz
          const { data: savedAction, error: actionError } = await supabase
            .from('action_requests')
            .insert({
              company_id: employee.company_id,
              employee_id: employee.id,
              type: actionData.type,
              title: actionData.title,
              detail: actionData.detail,
              status: 'created'
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 VUSERA Copilot API ${PORT} portunda işləyir`));

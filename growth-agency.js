import rateLimit from 'express-rate-limit';

const PRIORITIES = new Set(['A', 'B', 'C']);
const STATUSES = new Set(['Əlaqə qurulmayıb', 'Araşdırılır', 'Təsdiq gözləyir', 'Əlaqə quruldu', 'Demo planlanıb', 'Qazanıldı', 'İtirildi']);
const clean = (v, n = 2000) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isPlatformOwner = e => e?.is_platform_owner === true;

function requirePlatformOwner(req, res, next) {
  if (!isPlatformOwner(req.employee)) return res.status(403).json({ error: 'Growth Agency yalnız VUSERA platform owner üçün əlçatandır' });
  next();
}

function scenario(lead) {
  const s = (lead.sector || '').toLowerCase();
  if (s.includes('logistika')) return 'Daşınma sorğusu → sənəd yoxlaması → cavab draftı → rəhbər təsdiqi → follow-up';
  if (s.includes('təhsil')) return 'Müraciət → məlumat analizi → cavab draftı → konsultasiya görüşü → audit';
  if (s.includes('səhiyyə')) return 'İnzibati sorğu → siyasət sənədi → təsdiq → audit; tibbi məlumatlar pilotdan kənardır';
  if (s.includes('turizm')) return 'Korporativ səfər sorğusu → təklif draftı → təsdiq → görüş və follow-up';
  return 'Daxili sorğu → sənəd analizi → rəhbər təsdiqi → audit qeydi';
}

function fallbackDraft(lead) {
  return `Salam, ${lead.company_name} komandası. Mən VUSERA-nın təsisçisi Vüsal Əzizliyəm. VUSERA gündəlik email, sənəd və təsdiq proseslərini vahid AI işçi üzərindən idarə etməyə kömək edir. Sizin üçün ${scenario(lead).toLowerCase()} ssenarisinə uyğun qısa demo hazırlamaq istərdim. Bu həftə 15 dəqiqəlik görüş üçün uyğun vaxtınız varmı?\n\nHörmətlə,\nVüsal Əzizli\nFounder, VUSERA\nvusera.tech`;
}

function parseJson(text) {
  const raw = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) {
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(raw.slice(a, b + 1));
    throw new Error('AI nəticəsi JSON formatında deyil');
  }
}

async function activity(db, employee, eventType, description, metadata = {}) {
  const { error } = await db.from('growth_activities').insert({ company_id: employee.company_id, employee_id: employee.id, event_type: eventType, description, metadata });
  if (error) console.error('Growth activity yazılmadı:', error.message);
}

async function tenantLead(db, id, companyId) {
  if (!uuid(id)) return null;
  const { data, error } = await db.from('growth_leads').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (error) throw error;
  return data;
}

async function createCopy(anthropic, lead, objective) {
  const prompt = `Azərbaycan B2B bazarı üçün VUSERA adından qısa satış mesajı hazırla.

MƏCBURİ ROLLAR:
- Göndərən həmişə Vüsal Əzizli, Founder, VUSERA-dır.
- Məktubu alan potensial müştəri ${lead.company_name}-dir.
- Heç vaxt ${lead.company_name} adından yazma və onun xidmətlərini bizim təklifimiz kimi təqdim etmə.
- Satılan məhsul yalnız VUSERA AI işçisidir.
- İmza həmişə "Vüsal Əzizli\\nFounder, VUSERA\\nvusera.tech" olmalıdır.

Fakt uydurma, şişirtmə, zəmanət və yoxlanmamış nəticə vermə. Maksimum 120 söz. Məqsəd 15 dəqiqəlik uyğunlaşdırılmış demo almaqdır.
Alıcı şirkət: ${lead.company_name}
Sektor: ${lead.sector || 'bilinmir'}
Əlaqəli şəxs: ${lead.contact_name || 'bilinmir'}
Vəzifə: ${lead.contact_role || 'bilinmir'}
Kanal: ${lead.primary_channel || 'LinkedIn'}
Pilot: ${lead.pilot_scenario || scenario(lead)}
Məqsəd: ${objective || 'İlk əlaqə'}
Yalnız JSON qaytar: {"subject":"email mövzusu və ya boş","body":"mesaj","risk_level":"low və ya medium"}`;
  const response = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 450, temperature: 0.3, messages: [{ role: 'user', content: prompt }] });
  const result = parseJson(response.content?.find(x => x.type === 'text')?.text || '');
  return { ...result, usage: response.usage };
}

function leadPayload(body, employee) {
  return {
    company_id: employee.company_id,
    created_by: employee.id,
    priority: PRIORITIES.has(body.priority) ? body.priority : 'B',
    company_name: clean(body.companyName, 160),
    sector: clean(body.sector, 120),
    contact_name: clean(body.contactName, 120),
    contact_role: clean(body.contactRole, 120),
    contact_email: clean(body.contactEmail, 254).toLowerCase() || null,
    contact_phone: clean(body.contactPhone, 80) || null,
    linkedin_url: clean(body.linkedinUrl, 500) || null,
    primary_channel: clean(body.primaryChannel, 80) || 'LinkedIn',
    website: clean(body.website, 500) || null,
    notes: clean(body.notes, 3000),
    why_fit: clean(body.whyFit),
    pilot_scenario: clean(body.pilotScenario),
    status: STATUSES.has(body.status) ? body.status : 'Əlaqə qurulmayıb',
    next_step: clean(body.nextStep, 500) || 'İlk mesajı hazırla'
  };
}

export function registerGrowthAgencyRoutes({ app, supabase, anthropic, requireAuth, sendEmail }) {
  const aiLimit = rateLimit({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Agent sorğu limiti doldu. Bir dəqiqə sonra yenidən cəhd edin.' } });

  app.get('/growth/agents/status', requireAuth, requirePlatformOwner, (req, res) => res.json({
    agents: ['Growth Director', 'Lead Hunter', 'Sales Agent', 'Content Strategist', 'CRM Agent'].map((name, i) => ({ id: i + 1, name, status: 'online' })),
    externalActionsRequireApproval: true
  }));

  app.get('/growth/overview', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const companyId = req.employee.company_id;
      const [{ data: leads, error: le }, { data: drafts, error: de }] = await Promise.all([
        supabase.from('growth_leads').select('status').eq('company_id', companyId),
        supabase.from('growth_drafts').select('status').eq('company_id', companyId)
      ]);
      if (le) throw le; if (de) throw de;
      const byStatus = (leads || []).reduce((a, x) => (a[x.status] = (a[x.status] || 0) + 1, a), {});
      res.json({ totalLeads: leads?.length || 0, pendingDrafts: drafts?.filter(x => ['draft', 'pending_approval'].includes(x.status)).length || 0, positiveReplies: byStatus['Əlaqə quruldu'] || 0, demos: byStatus['Demo planlanıb'] || 0, won: byStatus['Qazanıldı'] || 0, byStatus });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/growth/leads', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      let q = supabase.from('growth_leads').select('*').eq('company_id', req.employee.company_id).order('priority').order('created_at', { ascending: false });
      if (PRIORITIES.has(req.query.priority)) q = q.eq('priority', req.query.priority);
      if (STATUSES.has(req.query.status)) q = q.eq('status', req.query.status);
      const { data, error } = await q.limit(Math.min(Number(req.query.limit) || 100, 200));
      if (error) throw error;
      const term = clean(req.query.search, 80).toLowerCase();
      const rows = term ? (data || []).filter(x => `${x.company_name} ${x.sector} ${x.contact_name}`.toLowerCase().includes(term)) : (data || []);
      res.json({ leads: rows || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/leads', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const payload = leadPayload(req.body, req.employee);
      if (!payload.company_name) return res.status(400).json({ error: 'companyName tələb olunur' });
      const { data, error } = await supabase.from('growth_leads').insert(payload).select().single();
      if (error) throw error;
      await activity(supabase, req.employee, 'lead_created', `${data.company_name} lead bazasına əlavə edildi`, { lead_id: data.id });
      res.status(201).json({ lead: data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/leads/import', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      if (!Array.isArray(req.body.leads) || !req.body.leads.length) return res.status(400).json({ error: 'leads array tələb olunur' });
      if (req.body.leads.length > 100) return res.status(400).json({ error: 'Bir dəfəyə maksimum 100 lead' });
      const rows = req.body.leads.map(x => leadPayload(x, req.employee)).filter(x => x.company_name);
      const { data, error } = await supabase.from('growth_leads').insert(rows).select();
      if (error) throw error;
      await activity(supabase, req.employee, 'leads_imported', `${data.length} lead idxal edildi`);
      res.status(201).json({ imported: data.length, leads: data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/growth/leads/:id', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const lead = await tenantLead(supabase, req.params.id, req.employee.company_id);
      if (!lead) return res.status(404).json({ error: 'Lead tapılmadı' });
      const fields = { priority: 'priority', companyName: 'company_name', sector: 'sector', contactName: 'contact_name', contactRole: 'contact_role', contactEmail: 'contact_email', contactPhone: 'contact_phone', linkedinUrl: 'linkedin_url', primaryChannel: 'primary_channel', website: 'website', notes: 'notes', whyFit: 'why_fit', pilotScenario: 'pilot_scenario', status: 'status', nextStep: 'next_step', demoAt: 'demo_at' };
      const updates = {};
      for (const [input, column] of Object.entries(fields)) if (req.body[input] !== undefined) {
        if (input === 'priority' && !PRIORITIES.has(req.body[input])) return res.status(400).json({ error: 'Yanlış prioritet' });
        if (input === 'status' && !STATUSES.has(req.body[input])) return res.status(400).json({ error: 'Yanlış status' });
        updates[column] = input === 'demoAt' ? req.body[input] : clean(req.body[input], 2000);
      }
      updates.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from('growth_leads').update(updates).eq('id', lead.id).eq('company_id', req.employee.company_id).select().single();
      if (error) throw error;
      await activity(supabase, req.employee, 'lead_updated', `${lead.company_name} yeniləndi`, { lead_id: lead.id });
      res.json({ lead: data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/growth/leads/:id', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const lead = await tenantLead(supabase, req.params.id, req.employee.company_id);
      if (!lead) return res.status(404).json({ error: 'Lead tapılmadı' });
      const { error } = await supabase.from('growth_leads').delete().eq('id', lead.id).eq('company_id', req.employee.company_id);
      if (error) throw error;
      await activity(supabase, req.employee, 'lead_deleted', `${lead.company_name} silindi`, { lead_id: lead.id });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/leads/discover', aiLimit, requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.body.limit) || 10, 1), 20);
      const sectors = clean(req.body.sectors, 500) || 'təhsil, logistika, turizm, peşəkar xidmətlər və orta ölçülü B2B şirkətlər';
      const { data: existing, error: existingError } = await supabase.from('growth_leads').select('company_name').eq('company_id', req.employee.company_id);
      if (existingError) throw existingError;
      const existingNames = (existing || []).map(x => x.company_name).filter(Boolean);
      const prompt = `VUSERA üçün Azərbaycan bazarında ${limit} real B2B lead namizədi hazırla. Sektorlar: ${sectors}.
VUSERA email, sənəd, daxili sorğu, görüş, təsdiq və iş axınlarını idarə edən AI işçidir.
Artıq bazada olanları təkrarlama: ${existingNames.join(', ') || 'yoxdur'}.
Yalnız mövcud olduğuna yüksək əmin olduğun şirkətləri yaz. Şəxsi məlumat uydurma. Email, telefon, LinkedIn və sayt dəqiq bilinmirsə boş saxla. Hər lead Araşdırılır statusunda olmalıdır.
Yalnız JSON qaytar: {"leads":[{"companyName":"","sector":"","priority":"A|B|C","contactName":"","contactRole":"","contactEmail":"","contactPhone":"","linkedinUrl":"","website":"","primaryChannel":"LinkedIn|Email|Instagram|Telefon","whyFit":"","pilotScenario":"","notes":"Avtomatik tapılıb; əlaqə məlumatları göndərmədən əvvəl yoxlanmalıdır"}]}`;
      const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0.2,
        tools: [{
          name: 'save_growth_leads',
          description: 'Tapılmış VUSERA lead namizədlərini strukturlaşdırılmış formada qaytarır',
          input_schema: {
            type: 'object',
            properties: {
              leads: {
                type: 'array',
                maxItems: 20,
                items: {
                  type: 'object',
                  properties: {
                    companyName: { type: 'string' }, sector: { type: 'string' }, priority: { type: 'string', enum: ['A', 'B', 'C'] },
                    contactName: { type: 'string' }, contactRole: { type: 'string' }, contactEmail: { type: 'string' }, contactPhone: { type: 'string' },
                    linkedinUrl: { type: 'string' }, website: { type: 'string' }, primaryChannel: { type: 'string', enum: ['LinkedIn', 'Email', 'Instagram', 'Telefon'] },
                    whyFit: { type: 'string' }, pilotScenario: { type: 'string' }, notes: { type: 'string' }
                  },
                  required: ['companyName', 'sector', 'priority', 'contactRole', 'primaryChannel', 'whyFit', 'pilotScenario']
                }
              }
            },
            required: ['leads']
          }
        }],
        tool_choice: { type: 'tool', name: 'save_growth_leads' },
        messages: [{ role: 'user', content: prompt }]
      });
      const toolResult = response.content?.find(x => x.type === 'tool_use' && x.name === 'save_growth_leads');
      if (!toolResult?.input || !Array.isArray(toolResult.input.leads)) throw new Error('Lead siyahısı strukturlaşdırılmış formada alınmadı. Yenidən cəhd edin.');
      const parsed = toolResult.input;
      const known = new Set(existingNames.map(x => x.trim().toLowerCase()));
      const rows = (Array.isArray(parsed.leads) ? parsed.leads : []).map(x => leadPayload({ ...x, status: 'Araşdırılır', nextStep: 'Əlaqə məlumatlarını yoxla' }, req.employee)).filter(x => x.company_name && !known.has(x.company_name.toLowerCase())).slice(0, limit);
      if (!rows.length) return res.json({ imported: 0, leads: [], message: 'Yeni unikal lead tapılmadı' });
      const { data, error } = await supabase.from('growth_leads').insert(rows).select();
      if (error) throw error;
      await activity(supabase, req.employee, 'leads_discovered', `${data.length} lead avtomatik tapılıb pipeline-a əlavə edildi`);
      res.status(201).json({ imported: data.length, leads: data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/leads/:id/generate-draft', aiLimit, requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const lead = await tenantLead(supabase, req.params.id, req.employee.company_id);
      if (!lead) return res.status(404).json({ error: 'Lead tapılmadı' });
      let copy;
      try { copy = await createCopy(anthropic, lead, clean(req.body.objective, 300)); }
      catch (err) { copy = { subject: '', body: fallbackDraft(lead), risk_level: 'low', usage: null, fallback: err.message }; }
      const { data, error } = await supabase.from('growth_drafts').insert({ company_id: req.employee.company_id, lead_id: lead.id, created_by: req.employee.id, channel: lead.primary_channel || 'LinkedIn', subject: clean(copy.subject, 200), body: clean(copy.body, 5000), status: 'pending_approval', risk_level: ['low', 'medium', 'high'].includes(copy.risk_level) ? copy.risk_level : 'medium', ai_model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', input_tokens: copy.usage?.input_tokens || null, output_tokens: copy.usage?.output_tokens || null }).select().single();
      if (error) throw error;
      await supabase.from('growth_leads').update({ status: 'Təsdiq gözləyir', next_step: 'Draftı yoxla və təsdiqlə', updated_at: new Date().toISOString() }).eq('id', lead.id).eq('company_id', req.employee.company_id);
      await activity(supabase, req.employee, 'draft_generated', `${lead.company_name} üçün draft hazırlandı`, { lead_id: lead.id, draft_id: data.id });
      res.status(201).json({ draft: data, fallbackUsed: !!copy.fallback });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/growth/drafts', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      let q = supabase.from('growth_drafts').select('*, growth_leads(company_name, contact_name, contact_email, primary_channel)').eq('company_id', req.employee.company_id).order('created_at', { ascending: false });
      if (req.query.status) q = q.eq('status', clean(req.query.status, 40));
      const { data, error } = await q.limit(Math.min(Number(req.query.limit) || 100, 200));
      if (error) throw error;
      res.json({ drafts: data || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/drafts/:id/approve', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      if (!uuid(req.params.id)) return res.status(400).json({ error: 'Yanlış draft ID' });
      const { data: draft, error: fe } = await supabase.from('growth_drafts').select('*, growth_leads(company_name)').eq('id', req.params.id).eq('company_id', req.employee.company_id).maybeSingle();
      if (fe) throw fe; if (!draft) return res.status(404).json({ error: 'Draft tapılmadı' });
      if (!['draft', 'pending_approval'].includes(draft.status)) return res.status(409).json({ error: 'Bu draft təsdiq edilə bilməz' });
      const now = new Date().toISOString();
      const { data, error } = await supabase.from('growth_drafts').update({ status: 'approved', approved_by: req.employee.id, approved_at: now, updated_at: now }).eq('id', draft.id).eq('company_id', req.employee.company_id).select().single();
      if (error) throw error;
      await supabase.from('growth_approvals').insert({ company_id: req.employee.company_id, draft_id: draft.id, approver_id: req.employee.id, decision: 'approved' });
      await activity(supabase, req.employee, 'draft_approved', `${draft.growth_leads?.company_name || 'Lead'} draftı təsdiqləndi`, { draft_id: draft.id });
      res.json({ draft: data, next: draft.channel?.toLowerCase().includes('email') ? 'send' : 'manual_handoff' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/drafts/:id/reject', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      if (!uuid(req.params.id)) return res.status(400).json({ error: 'Yanlış draft ID' });
      const { data: draft, error: fe } = await supabase.from('growth_drafts').select('id, lead_id').eq('id', req.params.id).eq('company_id', req.employee.company_id).maybeSingle();
      if (fe) throw fe; if (!draft) return res.status(404).json({ error: 'Draft tapılmadı' });
      const reason = clean(req.body.reason, 500), now = new Date().toISOString();
      const { data, error } = await supabase.from('growth_drafts').update({ status: 'rejected', rejection_reason: reason, updated_at: now }).eq('id', draft.id).eq('company_id', req.employee.company_id).select().single();
      if (error) throw error;
      await supabase.from('growth_approvals').insert({ company_id: req.employee.company_id, draft_id: draft.id, approver_id: req.employee.id, decision: 'rejected', reason });
      await supabase.from('growth_leads').update({ status: 'Araşdırılır', next_step: 'Mesajı yenidən hazırla', updated_at: now }).eq('id', draft.lead_id).eq('company_id', req.employee.company_id);
      await activity(supabase, req.employee, 'draft_rejected', 'Outreach draftı rədd edildi', { draft_id: draft.id, reason });
      res.json({ draft: data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/drafts/:id/send', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      if (!uuid(req.params.id)) return res.status(400).json({ error: 'Yanlış draft ID' });
      const { data: draft, error } = await supabase.from('growth_drafts').select('*, growth_leads(*)').eq('id', req.params.id).eq('company_id', req.employee.company_id).maybeSingle();
      if (error) throw error; if (!draft) return res.status(404).json({ error: 'Draft tapılmadı' });
      if (draft.status !== 'approved') return res.status(409).json({ error: 'Əvvəlcə draft təsdiqlənməlidir' });
      const lead = draft.growth_leads;
      if (!draft.channel?.toLowerCase().includes('email')) return res.status(409).json({ error: 'Bu kanal manual göndəriş tələb edir', manualHandoff: true });
      if (!lead?.contact_email) return res.status(400).json({ error: 'Lead email ünvanı yoxdur' });
      if (req.body.confirmFirstContact !== true) return res.status(428).json({ error: 'İlk xarici əlaqə geri qaytarılmır', requiresConfirmation: true });
      const since = new Date(Date.now() - 86400000).toISOString();
      const { count } = await supabase.from('growth_drafts').select('*', { count: 'exact', head: true }).eq('company_id', req.employee.company_id).eq('status', 'sent').gte('sent_at', since);
      const limit = Math.max(1, Number(process.env.GROWTH_DAILY_SEND_LIMIT) || 10);
      if ((count || 0) >= limit) return res.status(429).json({ error: `Gündəlik cold-email limiti (${limit}) dolub` });
      const result = await sendEmail(req.employee.company_id, lead.contact_email, draft.subject || `VUSERA × ${lead.company_name}`, draft.body);
      if (!result?.success) throw new Error(result?.error || 'Email göndərilmədi');
      const now = new Date().toISOString();
      await supabase.from('growth_drafts').update({ status: 'sent', sent_at: now, updated_at: now }).eq('id', draft.id).eq('company_id', req.employee.company_id);
      await supabase.from('growth_leads').update({ status: 'Əlaqə quruldu', last_contact_at: now, next_step: '3 iş günü sonra follow-up', updated_at: now }).eq('id', lead.id).eq('company_id', req.employee.company_id);
      await activity(supabase, req.employee, 'outreach_sent', `${lead.company_name} üçün email göndərildi`, { lead_id: lead.id, draft_id: draft.id, irreversible: true });
      res.json({ success: true, sentAt: now, irreversible: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/growth/sprints', aiLimit, requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const amount = Math.min(Math.max(Number(req.body.limit) || 5, 1), 5);
      const { data: leads, error } = await supabase.from('growth_leads').select('*').eq('company_id', req.employee.company_id).eq('status', 'Əlaqə qurulmayıb').order('priority').limit(amount);
      if (error) throw error;
      if (!leads?.length) return res.json({ run: null, drafts: [], message: 'Hazırlanacaq yeni lead yoxdur' });
      const { data: run, error: re } = await supabase.from('growth_agent_runs').insert({ company_id: req.employee.company_id, started_by: req.employee.id, run_type: 'daily_sprint', status: 'running', input: { limit: amount } }).select().single();
      if (re) throw re;
      const drafts = [];
      for (const lead of leads) {
        let copy;
        try { copy = await createCopy(anthropic, lead, 'İlk əlaqə'); } catch (_) { copy = { subject: '', body: fallbackDraft(lead), risk_level: 'low' }; }
        const { data: draft, error: de } = await supabase.from('growth_drafts').insert({ company_id: req.employee.company_id, lead_id: lead.id, agent_run_id: run.id, created_by: req.employee.id, channel: lead.primary_channel || 'LinkedIn', subject: clean(copy.subject, 200), body: clean(copy.body, 5000), status: 'pending_approval', risk_level: copy.risk_level || 'medium', ai_model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', input_tokens: copy.usage?.input_tokens || null, output_tokens: copy.usage?.output_tokens || null }).select().single();
        if (de) throw de;
        drafts.push(draft);
        await supabase.from('growth_leads').update({ status: 'Təsdiq gözləyir', next_step: 'Draftı yoxla və təsdiqlə', updated_at: new Date().toISOString() }).eq('id', lead.id).eq('company_id', req.employee.company_id);
      }
      const done = new Date().toISOString();
      await supabase.from('growth_agent_runs').update({ status: 'completed', completed_at: done, output: { draft_count: drafts.length } }).eq('id', run.id).eq('company_id', req.employee.company_id);
      await activity(supabase, req.employee, 'sprint_completed', `${drafts.length} fərdi draft hazırlandı`, { run_id: run.id });
      res.status(201).json({ run: { ...run, status: 'completed', completed_at: done }, drafts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/growth/activities', requireAuth, requirePlatformOwner, async (req, res) => {
    try {
      const { data, error } = await supabase.from('growth_activities').select('*').eq('company_id', req.employee.company_id).order('created_at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 50, 200));
      if (error) throw error;
      res.json({ activities: data || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

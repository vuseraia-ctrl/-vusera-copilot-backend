// server.js вЂ” VUSERA Employee Copilot API
//
// Endpoint-lЙ™r:
//   POST /ask        вЂ” iЕџГ§i sual verir, RAG ilЙ™ cavab alД±r (mЙ™nbЙ™/xГјlasЙ™/action ilЙ™)
//   GET  /employees   вЂ” demo ГјГ§Гјn iЕџГ§i siyahД±sД±
//   GET  /actions/:employeeId вЂ” iЕџГ§inin yaratdД±ДџД± sorДџular

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import PDFDocument from 'pdfkit';
import { google } from 'googleapis';

// ---- ЕћirkЙ™t-sЙ™viyyЙ™li inteqrasiya aГ§arlarД±nД± gЙ™tirir (yoxdursa, VUSERA-nД±n Г¶z demo aГ§arlarД±na qayД±dД±r) ----
async function getCompanyIntegrationCreds(companyId) {
  if (!companyId) return {};
  const { data } = await supabase
    .from('companies')
    .select('google_client_id, google_client_secret, google_refresh_token, slack_bot_token, hubspot_access_token')
    .eq('id', companyId)
    .single();
  return data || {};
}

// ---- BirbaЕџa Google Calendar API (Make.com-u keГ§Й™rЙ™k вЂ” "createAnEvent" bug-unu aradan qaldД±rmaq ГјГ§Гјn) ----
async function getGoogleCalendarClient(companyId) {
  const creds = await getCompanyIntegrationCreds(companyId);
  const clientId = creds.google_client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = creds.google_client_secret || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = creds.google_refresh_token || process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId) return null;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// GГ¶rГјЕџ yaradД±r вЂ” birbaЕџa Google Calendar API ilЙ™ (Make.com-suz), ЕџirkЙ™tin Г¶z aГ§arlarД± ilЙ™ (varsa)
async function createMeetingDirectGoogle(companyId, title, startDateTime, endDateTime, description) {
  const calendar = await getGoogleCalendarClient(companyId);
  if (!calendar) return { success: false, error: 'Google Calendar inteqrasiyasД± qurulmayД±b' };
  try {
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description: description || '',
        start: { dateTime: startDateTime },
        end: { dateTime: endDateTime }
      }
    });
    return { success: true, eventId: response.data.id, eventLink: response.data.htmlLink };
  } catch (e) {
    console.error('Google Calendar (birbaЕџa) xЙ™tasД±:', e.message);
    return { success: false, error: e.message };
  }
}

// GГ¶rГјЕџГј lЙ™Дџv edir вЂ” birbaЕџa Google Calendar API ilЙ™
async function cancelMeetingDirectGoogle(companyId, eventId) {
  const calendar = await getGoogleCalendarClient(companyId);
  if (!calendar) return { success: false };
  try {
    await calendar.events.delete({ calendarId: 'primary', eventId });
    return { success: true };
  } catch (e) {
    console.error('Google Calendar (birbaЕџa) lЙ™Дџv xЙ™tasД±:', e.message);
    return { success: false, error: e.message };
  }
}

// ---- BirbaЕџa HubSpot CRM API ----
async function searchHubSpotContact(companyId, query) {
  const creds = await getCompanyIntegrationCreds(companyId);
  const token = creds.hubspot_access_token || process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return { success: false, error: 'HubSpot inteqrasiyasД± qurulmayД±b' };
  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query, properties: ['firstname', 'lastname', 'email', 'phone', 'company'], limit: 5 })
    });
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.message };
    return { success: true, contacts: (data.results || []).map(r => r.properties) };
  } catch (e) {
    console.error('HubSpot axtarД±Еџ xЙ™tasД±:', e.message);
    return { success: false, error: e.message };
  }
}

async function createHubSpotContact(companyId, firstname, lastname, email, phone, company) {
  const creds = await getCompanyIntegrationCreds(companyId);
  const token = creds.hubspot_access_token || process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return { success: false, error: 'HubSpot inteqrasiyasД± qurulmayД±b' };
  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ properties: { firstname, lastname, email, phone, company } })
    });
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.message };
    return { success: true, contactId: data.id };
  } catch (e) {
    console.error('HubSpot yaratma xЙ™tasД±:', e.message);
    return { success: false, error: e.message };
  }
}


// ---- BirbaЕџa Slack API (Make.com-un client_id problemini keГ§mЙ™k ГјГ§Гјn) ----
async function sendSlackMessage(companyId, channel, text) {
  const creds = await getCompanyIntegrationCreds(companyId);
  const token = creds.slack_bot_token || process.env.SLACK_BOT_TOKEN;
  if (!token) return { success: false, error: 'Slack inteqrasiyasД± qurulmayД±b' };
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ channel, text })
    });
    const data = await response.json();
    if (!data.ok) return { success: false, error: data.error };
    return { success: true };
  } catch (e) {
    console.error('Slack xЙ™tasД±:', e.message);
    return { success: false, error: e.message };
  }
}

// ---- BirbaЕџa Google Sheets API (Make.com-un icazЙ™ problemini keГ§mЙ™k ГјГ§Гјn) ----
async function getGoogleSheetsClient(companyId) {
  const creds = await getCompanyIntegrationCreds(companyId);
  const clientId = creds.google_client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = creds.google_client_secret || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = creds.google_refresh_token || process.env.GOOGLE_REFRESH_TOKEN;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

// HesabatД± birbaЕџa Google Sheets-Й™ ixrac edir (yeni spreadsheet yaradД±b, sЙ™trlЙ™ri yazД±r)
async function exportToSheetsDirectGoogle(companyId, title, rows) {
  try {
    const sheets = await getGoogleSheetsClient(companyId);
    const createResponse = await sheets.spreadsheets.create({
      requestBody: { properties: { title } }
    });
    const spreadsheetId = createResponse.data.spreadsheetId;
    const spreadsheetUrl = createResponse.data.spreadsheetUrl;

    const values = rows.map(r => r.values);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    return { success: true, spreadsheetUrl };
  } catch (e) {
    console.error('Google Sheets (birbaЕџa) xЙ™tasД±:', e.message);
    return { success: false, error: e.message };
  }
}
import { supabase, supabaseAuth, getEmbedding, chunkDocument } from './lib.js';
import { registerGrowthAgencyRoutes } from './growth-agency.js';

const app = express();
app.set('trust proxy', 1); // Render bir proksi arxasД±nda iЕџlЙ™diyi ГјГ§Гјn, real IP-ni dГјzgГјn tanД±maq ГјГ§Гјn lazД±mdД±r
app.use(cors());
app.use(express.json({ limit: '10mb' })); // qЙ™bz/PDF ЕџЙ™killЙ™ri ГјГ§Гјn bГ¶yГјk body limiti

// JSON formatД± sЙ™hv olan sorДџular ГјГ§Гјn aydД±n xЙ™ta
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'GГ¶ndЙ™rilЙ™n JSON formatД± sЙ™hvdir' });
  }
  next(err);
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Her tapsiriq novu ucun, senaye ortalamasina esaslanan, teqribi qenaet (deqiqe)
const TIME_SAVED_MINUTES = { leave_request: 12, it_ticket: 18, expense_request: 15, send_email: 8, create_meeting: 10, generate_report: 25, compare_documents: 20, meeting_prep: 15, send_message: 3, cancel_meeting: 5 };

// GeniЕџlendirilmiЕџ tesnifat: QISA ve IS elaqeli acar soz OLMAYAN mesajlar (adi soбёЈbet) Haiku-ya gedir.
// Herhansi bir IS/sorДџu acar sozu varsa (mezuniyyet, ticket, sened ve s.), HEMISHE Sonnet-de qalir вЂ”
// bu, tehlukesiz terefdir, chunki bu acar sozler REAL emeliyyat/bilik bazasi lazim olduДџunu gosterir.
function isSimpleGreeting(text) {
  const t = text.trim().toLowerCase();
  if (t.length > 60) return false; // uzun mesajlar hec vaxt "sade chat" hesab edilmir
  // VACIB: tesdiq/redd sozleri, HEC VAXT Haiku-ya getmemelidir - bunlar, 2-addimli
  // ACTION yaratma prosesinin EN KRITIK addimidir (JSON deqiqliyi teleb edir)
  const confirmationWords = [
    'bЙ™li', 'beli', 'hЙ™', 'he', 'tЙ™sdiq', 'tesdiq', 'yox', 'xeyr', 'lЙ™Дџv', 'legv',
    'yes', 'no', 'confirm', 'approve', 'reject'
  ];
  const confirmationRegex = new RegExp(`\\b(${confirmationWords.join('|')})\\b`, 'i');
  if (confirmationRegex.test(t)) return false;
  const workKeywords = [
    'mЙ™zuniyyЙ™t', 'mezuniyyet', 'ticket', 'sorДџu', 'sorgu', 'sЙ™nЙ™d', 'senedi', 'sened',
    'hesabat', 'tЙ™sdiq', 'tesdiq', 'email', 'gГ¶rГјЕџ', 'gorush', 'meeting', 'xЙ™rc', 'xerc',
    'policy', 'siyasЙ™t', 'siyaset', 'qayda', 'calendar', 'slack', 'crm', 'audit', 'crm',
    'yarat', 'gГ¶ndЙ™r', 'gonder', 'planla', 'mГјqayisЙ™', 'muqayise', 'hazД±rla', 'hazirla',
    'laptop', 'komputer', 'wifi', 'ЕџЙ™bЙ™kЙ™', 'sebeke', 'problem', 'xЙ™bЙ™rdar', 'xeberdar'
  ];
  if (workKeywords.some(k => t.includes(k))) return false;
  return true; // qisa, is-elaqeli acar sozu olmayan mesaj -> Haiku (adi sohbet)
}

// SadЙ™ UUID format yoxlamasД± (yanlД±Еџ ID-lЙ™rЙ™ aydД±n xЙ™ta vermЙ™k ГјГ§Гјn)
function isValidUUID(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ---- VUSERA Actions Router вЂ” bГјtГјn Make.com inteqrasiyalarД± TЖЏK bir webhook-dan keГ§ir ----
// (Pulsuz Make planД±nda yalnД±z 2 aktiv ssenari icazЙ™li olduДџu ГјГ§Гјn, hamД±sД±nД± "action" sahЙ™sinЙ™ gГ¶rЙ™
// bir Router-dЙ™ birlЙ™ЕџdirmiЕџik: send_email | check_calendar | create_meeting | read_emails)
async function callVuseraRouter(action, payload, retriesLeft = 1) {
  if (!process.env.MAKE_ROUTER_URL) return null;
  try {
    const response = await fetch(process.env.MAKE_ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
    if (!response.ok && retriesLeft > 0) {
      console.error(`Router (${action}) HTTP ${response.status} вЂ” yenidЙ™n cЙ™hd edilir (${retriesLeft} qalД±b)`);
      await new Promise(r => setTimeout(r, 800));
      return callVuseraRouter(action, payload, retriesLeft - 1);
    }
    return await response.json();
  } catch (e) {
    if (retriesLeft > 0) {
      console.error(`Router (${action}) ЕџЙ™bЙ™kЙ™ xЙ™tasД± вЂ” yenidЙ™n cЙ™hd edilir (${retriesLeft} qalД±b): ${e.message}`);
      await new Promise(r => setTimeout(r, 800));
      return callVuseraRouter(action, payload, retriesLeft - 1);
    }
    console.error(`Router (${action}) xЙ™tasД± (bГјtГјn cЙ™hdlЙ™r bitdi):`, e.message);
    return null;
  }
}

// ---- BirbaЕџa Gmail API (Make.com-un limit/pause problemini keГ§mЙ™k ГјГ§Гјn) ----
async function getGmailClient(companyId) {
  const creds = await getCompanyIntegrationCreds(companyId);
  const clientId = creds.google_client_id || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = creds.google_client_secret || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = creds.google_refresh_token || process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId) return null;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function readRecentEmailsDirect(companyId, includeMeta = false) {
  const gmail = await getGmailClient(companyId);
  if (!gmail) return [];
  try {
    const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 10, labelIds: ['INBOX'] });
    const messages = listRes.data.messages || [];
    const emails = [];
    for (const m of messages) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
      const headers = msg.data.payload?.headers || [];
      const fromHeader = headers.find(h => h.name === 'From')?.value || '';
      const subjectHeader = headers.find(h => h.name === 'Subject')?.value || '';
      const fromNameMatch = fromHeader.match(/^"?([^"<]+)"?\s*</);
      const emailObj = {
        fromName: fromNameMatch ? fromNameMatch[1].trim() : fromHeader,
        fromEmail: (fromHeader.match(/<(.+)>/) || [, fromHeader])[1],
        subject: subjectHeader,
        snippet: msg.data.snippet || ''
      };
      if (includeMeta) {
        emailObj.isUnread = (msg.data.labelIds || []).includes('UNREAD');
        emailObj.internalDate = msg.data.internalDate; // ms-epoch string
      }
      emails.push(emailObj);
    }
    return emails;
  } catch (e) {
    console.error('Gmail (birbaЕџa) oxuma xЙ™tasД±:', e.message);
    return [];
  }
}

async function sendEmailDirect(companyId, to, subject, body) {
  const gmail = await getGmailClient(companyId);
  if (!gmail) return { success: false, error: 'Gmail inteqrasiyasД± qurulmayД±b' };
  try {
    const messageParts = [
      `To: ${to}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${subject}`,
      '',
      body
    ];
    const message = messageParts.join('\n');
    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMessage } });
    return { success: true };
  } catch (e) {
    console.error('Gmail (birbaЕџa) gГ¶ndЙ™rmЙ™ xЙ™tasД±:', e.message);
    return { success: false, error: e.message };
  }
}

async function readRecentEmails(companyId) {
  return await readRecentEmailsDirect(companyId);
}

async function sendEmailViaMake(companyId, to, subject, body) {
  return await sendEmailDirect(companyId, to, subject, body);
}

async function checkCalendarAvailability(timeMin, timeMax) {
  const data = await callVuseraRouter('check_calendar', { timeMin, timeMax });
  return data?.busy || [];
}

async function createMeetingViaMake(title, startDateTime, endDateTime, description) {
  // "end" tarixi Google Calendar modulunda qЙ™ribЙ™ bir xЙ™ta verdiyi ГјГ§Гјn, bunun Й™vЙ™zinЙ™
  // mГјddЙ™ti (HH:mm formatД±nda) hesablayД±b gГ¶ndЙ™ririk вЂ” bu, daha etibarlД± iЕџlЙ™yir.
  let duration = '00:30';
  try {
    const diffMs = new Date(endDateTime) - new Date(startDateTime);
    if (diffMs > 0) {
      const totalMinutes = Math.round(diffMs / 60000);
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      duration = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  } catch (e) { /* default 00:30 qalД±r */ }

  // "+04:00" formatД±ndakД± "+" iЕџarЙ™si webhook Г¶tГјrГјlmЙ™sindЙ™ korlana bildiyi ГјГ§Гјn,
  // tarixi UTC-yЙ™ Г§eviririk (sonu "Z" ilЙ™ bitЙ™n format, "+" iЕџarЙ™si olmadan)
  let safeStartDateTime = startDateTime;
  try {
    safeStartDateTime = new Date(startDateTime).toISOString();
  } catch (e) { /* orijinal dЙ™yЙ™r qalД±r */ }

  const data = await callVuseraRouter('create_meeting', { title, startDateTime: safeStartDateTime, duration, description });
  return { success: data?.success === true, eventLink: data?.eventLink, eventId: data?.eventId };
}

async function cancelMeetingViaMake(eventId) {
  const data = await callVuseraRouter('cancel_meeting', { eventId });
  return { success: data?.success === true };
}

async function exportToSheetsViaMake(title, rows) {
  const data = await callVuseraRouter('export_sheets', { title, rows });
  return { success: data?.success === true, spreadsheetUrl: data?.spreadsheetUrl };
}

// PDFKit-in standart Еџrifti AzЙ™rbaycan hЙ™rflЙ™rini (Й™,Еџ,Г§,Дџ,Д±,Г¶,Гј) dЙ™stЙ™klЙ™mir вЂ”
// bunlarД± oxunaqlД± latД±n hЙ™rflЙ™rinЙ™ Г§eviririk ki, PDF-dЙ™ zir-zibil (mojibake) Г§Д±xmasД±n
function toPdfSafeText(text) {
  if (!text) return '';
  const map = { 'Й™':'e', 'ЖЏ':'E', 'Еџ':'sh', 'Ећ':'Sh', 'Г§':'ch', 'Г‡':'Ch', 'Дџ':'g', 'Дћ':'G', 'Д±':'i', 'Д°':'I', 'Г¶':'o', 'Г–':'O', 'Гј':'u', 'Гњ':'U' };
  return text.replace(/[Й™ЖЏЕџЕћГ§Г‡ДџДћД±Д°Г¶Г–ГјГњ]/g, ch => map[ch] || ch);
}
async function generateReportPdf(companyId, reportTitle, filters) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1) MЙ™lumatД± verilЙ™nlЙ™r bazasД±ndan Г§Й™k
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

      // 2) PDF-i "yaddaЕџda" (memory-dЙ™) qur
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(chunks);

        // 3) Supabase Storage-a yГјklЙ™
        const fileName = `${companyId}/reports/${Date.now()}-report.pdf`;
        const { error: uploadError } = await supabase.storage
          .from('documents')
          .upload(fileName, pdfBuffer, { contentType: 'application/pdf' });

        if (uploadError) return resolve({ success: false, error: uploadError.message });

        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
        resolve({ success: true, url: urlData?.publicUrl, rowCount: rows.length });
      });

      // 4) PDF mЙ™zmununu yaz
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

// SualД±n email haqqД±nda olub-olmadД±ДџД±nД± sadЙ™cЙ™ aГ§ar sГ¶zlЙ™rlЙ™ yoxlayД±r
function isEmailRelated(question) {
  const keywords = ['email', 'e-mail', 'e-poГ§t', 'epoГ§t', 'poГ§t', 'mЙ™ktub', 'inbox', 'gЙ™lЙ™n qutu'];
  const lower = question.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ---- REAL LOGIN sistemi ----

// Д°stifadЙ™Г§i email+parol ilЙ™ daxil olur, Й™vЙ™zindЙ™ bir "token" alД±r
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email vЙ™ password tЙ™lЙ™b olunur' });

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Email vЙ™ ya parol yanlД±ЕџdД±r' });

    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, departments(name), companies(name)')
      .eq('auth_user_id', data.user.id)
      .single();
    if (empError || !employee) return res.status(404).json({ error: 'Bu istifadЙ™Г§iyЙ™ baДџlД± iЕџГ§i tapД±lmadД±' });

    res.json({
      token: data.session.access_token,
      employee: { id: employee.id, name: employee.name, role: employee.role, is_platform_owner: employee.is_platform_owner === true, department: employee.departments?.name, companyName: employee.companies?.name, company_id: employee.company_id }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bu, gЙ™lЙ™n "Bearer token"-i yoxlayД±r vЙ™ hansД± iЕџГ§i olduДџunu tapД±b req.employee-yЙ™ yazД±r.
// BГјtГјn ЕџЙ™xsi/hЙ™ssas endpoint-lЙ™r bunu tЙ™lЙ™b edir вЂ” artД±q sadЙ™cЙ™ ID bilmЙ™klЙ™ baЕџqasД±nД±n yerinЙ™ keГ§mЙ™k mГјmkГјn deyil.
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'GiriЕџ tЙ™lЙ™b olunur (token yoxdur)' });
  }
  const token = authHeader.replace('Bearer ', '');

  try {
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
    if (userError || !userData?.user) return res.status(401).json({ error: 'Token etibarsД±zdД±r vЙ™ ya vaxtД± bitib' });

    let { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, departments(name)')
      .eq('auth_user_id', userData.user.id)
      .single();

    // PREMIUM SSO: Й™gЙ™r auth_user_id ilЙ™ tapД±lmadД±sa (mЙ™s: ilk dЙ™fЙ™ Google SSO ilЙ™ daxil olur),
    // email ilЙ™ uyДџunlaЕџdД±rmaДџa cЙ™hd et вЂ” YALNIZ Premium ЕџirkЙ™tlЙ™rdЙ™, bir dЙ™fЙ™lik "baДџlama" et
    if ((empError || !employee) && userData.user.email) {
      const { data: emailMatch } = await supabase
        .from('employees')
        .select('*, departments(name), companies(plan_name)')
        .eq('email', userData.user.email)
        .is('auth_user_id', null)
        .maybeSingle();
      if (emailMatch && emailMatch.companies?.plan_name === 'Premium') {
        await supabase.from('employees').update({ auth_user_id: userData.user.id }).eq('id', emailMatch.id);
        employee = emailMatch;
        empError = null;
      }
    }

    if (empError || !employee) return res.status(404).json({ error: 'Д°stifadЙ™Г§iyЙ™ baДџlД± iЕџГ§i tapД±lmadД±' });

    // KRД°TД°K: deaktiv edilmiЕџ (iЕџdЙ™n Г§Д±xarД±lmД±Еџ) iЕџГ§inin, hЙ™lЙ™ etibarlД± token-i olsa belЙ™,
    // sistemdЙ™n istifadЙ™ etmЙ™sinin qarЕџД±sД±nД± al
    if (employee.status === 'inactive') {
      return res.status(403).json({ error: 'Bu hesab deaktiv edilib. SuallarД±nД±z ГјГ§Гјn Admin ilЙ™ Й™laqЙ™ saxlayД±n.' });
    }

    req.employee = employee;
    next();
  } catch (err) {
    res.status(500).json({ error: 'GiriЕџ yoxlamasД± uДџursuz oldu' });
  }
}

// Д°stifadЙ™Г§i kimliyini (Й™vvЙ™lcЙ™dЙ™n saxlanД±lan tokenlЙ™) yoxlamaq ГјГ§Гјn
app.get('/auth/me', requireAuth, async (req, res) => {
  const { data: companyData } = await supabase.from('companies').select('name').eq('id', req.employee.company_id).single();
  res.json({ employee: { id: req.employee.id, name: req.employee.name, role: req.employee.role, is_platform_owner: req.employee.is_platform_owner === true, department: req.employee.departments?.name, companyName: companyData?.name, company_id: req.employee.company_id } });
});

// VerilЙ™nlЙ™r bazasД±nda in-app bildiriЕџ yaradД±r (fire-and-forget вЂ” uДџursuz olsa Й™sas Й™mЙ™liyyatД± pozmasД±n)
async function createNotification(companyId, employeeId, message, relatedActionId = null) {
  try {
    await supabase.from('notifications').insert({
      company_id: companyId,
      employee_id: employeeId,
      message,
      related_action_id: relatedActionId
    });
  } catch (e) {
    console.error('BildiriЕџ yaradД±la bilmЙ™di:', e.message);
  }
}

// ---- SadЙ™ API aГ§arД± yoxlamasД± (tam authentication deyil, amma tЙ™sadГјfi sorДџulara qarЕџД± maneЙ™dir) ----
// Real login sistemi qurulana qЙ™dЙ™r, hЙ™r sorДџu bu gizli aГ§arД± bilmЙ™lidir.
function checkApiSecret(req, res, next) {
  // OWNER-ONLY endpoint-lЙ™r (bunlarД±n Г¶z, ayrД±ca OWNER_SECRET yoxlamasД± var, bu qlobal qapД± onlara aid deyil)
  const ownerOnlyPaths = ['/companies', '/proactive/check-reminders', '/internal/cost-tracking',
    '/premium/daily-briefing', '/internal/subscriptions', '/onboarding/new-company', '/oauth/google'];
  if (ownerOnlyPaths.some(p => req.path.startsWith(p))) return next();

  const provided = req.headers['x-api-secret'];
  if (!process.env.API_SECRET) return next(); // .env-dЙ™ tЙ™yin olunmayД±bsa, keГ§ir (development ГјГ§Гјn)
  if (provided !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'EtibarsД±z API aГ§arД±' });
  }
  next();
}
app.use(checkApiSecret);

// ---- Rate limiting вЂ” sui-istifadЙ™yЙ™/hЙ™ddindЙ™n artД±q sorДџuya qarЕџД± Й™lavЙ™ maneЙ™ ----
// Auth sistemi olmadД±ДџД± ГјГ§Гјn, Й™n azД± hЙ™r IP-nin dЙ™qiqЙ™dЙ™ etdiyi sorДџu sayД±nД± mЙ™hdudlaЕџdД±rД±rД±q.
const askLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 dЙ™qiqЙ™
  max: 20,             // hЙ™r IP ГјГ§Гјn dЙ™qiqЙ™dЙ™ maksimum 20 sorДџu
  message: { error: 'Г‡ox tez-tez sorДџu gГ¶ndЙ™rirsiniz. Bir azdan yenidЙ™n cЙ™hd edin.' },
  standardHeaders: true,
  legacyHeaders: false
});
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // sЙ™nЙ™d yГјklЙ™mЙ™ daha az tez-tez baЕџ verir
  message: { error: 'Г‡ox tez-tez sЙ™nЙ™d yГјklЙ™yirsiniz. Bir azdan yenidЙ™n cЙ™hd edin.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ---- KГ¶mЙ™kГ§i funksiyalar ----

// Rolun "yГјksЙ™k icazЙ™li" olub-olmadД±ДџД±nД± yoxlayД±r (HR/Finance Manager, Admin)
function hasElevatedAccess(role) {
  return ['HR Manager', 'Finance Manager', 'Admin'].includes(role);
}

// TapД±lan parГ§alarД± iЕџГ§inin roluna gГ¶rЙ™ filtrlЙ™ вЂ” icazЙ™si olmayan sЙ™nЙ™dlЙ™ri Г§Д±xar
function filterByPermission(chunks, employeeRole) {
  return chunks.filter(chunk => {
    if (!chunk.restricted_to_roles || chunk.restricted_to_roles.length === 0) return true;
    return chunk.restricted_to_roles.includes(employeeRole);
  });
}

// ---- ЖЏsas endpoint: /ask ----

app.post('/ask', askLimiter, requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    const employeeId = req.employee.id; // artД±q body-dЙ™n deyil, dogrulanmД±Еџ tokendЙ™n gЙ™lir
    if (typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'question boЕџ ola bilmЙ™z' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: 'Sual Г§ox uzundur (maksimum 2000 simvol)' });
    }

    // 1) Д°ЕџГ§ini tap (rol, ЕџirkЙ™t)
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*, departments(name)')
      .eq('id', employeeId)
      .single();
    if (empError || !employee) return res.status(404).json({ error: 'Д°ЕџГ§i tapД±lmadД±' });

    // 1.5) ЕћirkЙ™tin abunЙ™lik statusunu yoxla вЂ” gecikmiЕџ/lЙ™Дџv edilmiЕџ hesablar ГјГ§Гјn giriЕџi mЙ™hdudlaЕџdД±r
    // ETД°K QAYDA: yalnД±z Admin real sЙ™bЙ™bi (Г¶dЙ™niЕџ) gГ¶rГјr, adi iЕџГ§ilЙ™rЙ™ maliyyЙ™ statusu aГ§Д±qlanmД±r
    const { data: companyStatus } = await supabase
      .from('companies')
      .select('subscription_status, plan_name')
      .eq('id', employee.company_id)
      .single();
    if (companyStatus && (companyStatus.subscription_status === 'cancelled' || companyStatus.subscription_status === 'past_due')) {
      const isAdminViewer = employee.role === 'Admin';
      return res.status(402).json({
        error: isAdminViewer
          ? (companyStatus.subscription_status === 'cancelled'
              ? 'AbunЙ™lik lЙ™Дџv edilib. Davam etmЙ™k ГјГ§Гјn VUSERA ilЙ™ Й™laqЙ™ saxlayД±n.'
              : 'Г–dЙ™niЕџ gecikib. XidmЙ™tЙ™ davam etmЙ™k ГјГ§Гјn Г¶dЙ™niЕџi tamamlayД±n.')
          : 'VUSERA hazД±rda mГјvЙ™qqЙ™ti Й™lГ§atan deyil. ZЙ™hmЙ™t olmasa Admin ilЙ™ Й™laqЙ™ saxlayД±n.'
      });
    }

    // 1.6) AYLIQ Д°STД°FADЖЏ LД°MД°TД° вЂ” Д°ЕћГ‡Д° SAYINA GГ–RЖЏ MД°QYASLANIR (flat rЙ™qЙ™m Й™dalЙ™tsiz olardД± вЂ”
    // 5 iЕџГ§ili ЕџirkЙ™t ilЙ™ 20 iЕџГ§ili ЕџirkЙ™t eyni limiti almamalД±dД±r)
    const QUERIES_PER_EMPLOYEE_PER_DAY = { Premium: 25, Business: 15 };
    const perEmployeeDaily = QUERIES_PER_EMPLOYEE_PER_DAY[companyStatus?.plan_name] || QUERIES_PER_EMPLOYEE_PER_DAY.Business;
    const { count: activeEmployeeCount } = await supabase
      .from('employees').select('*', { count: 'exact', head: true })
      .eq('company_id', employee.company_id).eq('status', 'active');
    const monthlyLimit = Math.max(500, (activeEmployeeCount || 1) * perEmployeeDaily * 30); // minimum 500, kicik sirketler ucun de manali qalsin
    const monthlyTokenLimit = monthlyLimit * 1750 * 3; // hesabat: ~1750 "teze" token/sorgu ortalamasД±, 3x tehlukesizlik marjД± ile
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const [{ count: monthlyUsageCount }, { data: tokenRows }] = await Promise.all([
      supabase.from('chat_logs').select('*', { count: 'exact', head: true }).eq('company_id', employee.company_id).gte('created_at', startOfMonth),
      supabase.from('chat_logs').select('input_tokens, output_tokens').eq('company_id', employee.company_id).gte('created_at', startOfMonth)
    ]);
    const monthlyTokenTotal = (tokenRows || []).reduce((sum, r) => sum + (r.input_tokens || 0) + (r.output_tokens || 0), 0);

    if ((monthlyUsageCount !== null && monthlyUsageCount >= monthlyLimit) || monthlyTokenTotal >= monthlyTokenLimit) {
      const isAdminViewer = employee.role === 'Admin';
      const reachedTokenLimit = monthlyTokenTotal >= monthlyTokenLimit;
      return res.status(429).json({
        error: isAdminViewer
          ? (reachedTokenLimit
              ? `Bu ay ГјГ§Гјn token istifadЙ™ limitinЙ™ Г§atД±lД±b. Limitin artД±rД±lmasД± ГјГ§Гјn VUSERA ilЙ™ Й™laqЙ™ saxlayД±n.`
              : `Bu ay ГјГ§Гјn sorДџu limitinЙ™ (${monthlyLimit}) Г§atД±lД±b. Limitin artД±rД±lmasД± ГјГ§Гјn VUSERA ilЙ™ Й™laqЙ™ saxlayД±n.`)
          : 'VUSERA bu ay ГјГ§Гјn istifadЙ™ limitinЙ™ Г§atД±b. ZЙ™hmЙ™t olmasa Admin ilЙ™ Й™laqЙ™ saxlayД±n.'
      });
    }

    // 2) SualД±n embedding-ini yarat
    let queryEmbedding;
    try {
      queryEmbedding = await getEmbedding(question);
    } catch (e) {
      console.error('Voyage AI xЙ™tasД±:', e.message);
      return res.status(503).json({ error: 'AxtarД±Еџ sistemi hazД±rda Й™lГ§atan deyil. Bir azdan yenidЙ™n cЙ™hd edin.' });
    }

    // 3) Vector axtarД±ЕџД± ilЙ™ Й™n oxЕџar parГ§alarД± tap
    // "XГјlasЙ™ et" tipli suallar ГјГ§Гјn daha Г§ox parГ§a gЙ™tiririk ki, sЙ™nЙ™din tam mЙ™nzЙ™rЙ™si olsun
    const isSummaryRequest = /xГјlas|xulase|qД±saca izah|summary|icmal/i.test(question);
    const { data: matches, error: matchError } = await supabase.rpc('match_chunks', {
      query_embedding: queryEmbedding,
      match_company_id: employee.company_id,
      match_count: isSummaryRequest ? 20 : 4
    });
    if (matchError) throw matchError;

    // 3.2) BAЕћLIQ-ЖЏSASLI TЖЏMД°NAT: Й™gЙ™r sual, mГ¶vcud bir sЙ™nЙ™din adД±nД± (demЙ™k olar) birbaЕџa ehtiva edirsЙ™,
    // amma semantik axtarД±Еџ onu tapmayД±bsa, o sЙ™nЙ™di Й™l ilЙ™ Й™lavЙ™ edirik (embedding zЙ™ifliyinin qarЕџД±sД±nД± almaq ГјГ§Гјn)
    const { data: allDocTitles } = await supabase
      .from('documents')
      .select('id, title')
      .eq('company_id', employee.company_id);
    const titleMentioned = (allDocTitles || []).find(d =>
      d.title.length > 4 && question.toLowerCase().includes(d.title.toLowerCase())
    );
    let finalMatches = matches || [];
    if (titleMentioned && !finalMatches.some(m => m.document_id === titleMentioned.id)) {
      const { data: extraChunks } = await supabase
        .from('document_chunks')
        .select('id, document_id, section_label, content, documents!inner(title, doc_code, restricted_to_roles)')
        .eq('document_id', titleMentioned.id);
      const mapped = (extraChunks || []).map(c => ({
        chunk_id: c.id, document_id: c.document_id, document_title: c.documents.title,
        doc_code: c.documents.doc_code, restricted_to_roles: c.documents.restricted_to_roles,
        section_label: c.section_label, content: c.content, similarity: 1
      }));
      finalMatches = [...mapped, ...finalMatches];
    }

    // 3.5) SГ¶hbЙ™t yaddaЕџД± вЂ” bu iЕџГ§inin son 6 mesajД±nД± gЙ™tir ki, Claude
    // Й™vvЙ™lki suallarД± "xatД±rlaya" bilsin (mЙ™s: "bЙ™s hЙ™ftЙ™dЙ™ neГ§Й™ gГјn?")
    const { data: history } = await supabase
      .from('chat_logs')
      .select('question, answer')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(6);

    const conversationMessages = [];
    if (history && history.length > 0) {
      // ЖЏn kГ¶hnЙ™dЙ™n Й™n yeniyЙ™ doДџru sД±rala (Claude-a dГјzgГјn xronoloji ardД±cД±llД±qla veririk)
      // Token qЙ™naЙ™ti ГјГ§Гјn: KГ–HNЖЏ cavablarД± qД±saldД±rД±q (yalnД±z son 2 cГјtГј tam saxlayД±rД±q),
      // Г§Гјnki kГ¶hnЙ™ cavablarД±n TAM detalД± (mЙ™nbЙ™ sitatlarД±, uzun izahlar) adЙ™tЙ™n lazД±m olmur вЂ”
      // yalnД±z "nЙ™ haqqД±nda danД±ЕџdД±ДџД±mД±z" kontekst kifayЙ™tdir.
      const reversedHistory = history.reverse();
      reversedHistory.forEach((h, idx) => {
        const isRecent = idx >= reversedHistory.length - 2; // son 2 cГјt tam qalД±r
        const answerText = isRecent ? h.answer : (h.answer.length > 200 ? h.answer.slice(0, 200) + 'вЂ¦ (qД±saldД±lД±b)' : h.answer);
        conversationMessages.push({ role: 'user', content: h.question });
        conversationMessages.push({ role: 'assistant', content: answerText });
      });
    }
    conversationMessages.push({ role: 'user', content: question });

    // 3.55) AДџД±llД± yaddaЕџ вЂ” iЕџГ§i haqqД±nda gЙ™lЙ™cЙ™kdЙ™ faydalД± faktlarД± kontekstЙ™ Й™lavЙ™ et
    let employeeMemoryText = '';
    const isPremiumCompany = true; // Smart Memory is enabled for all active VUSERA plans.
    if (employee.company_id) {
      const { data: memories } = await supabase
        .from('employee_memory')
        .select('fact')
        .eq('employee_id', employeeId)
        .order('created_at', { ascending: false })
        .limit(8);
      if (memories && memories.length > 0) {
        employeeMemoryText = '\nBU Д°ЕћГ‡Д° HAQQINDA XATIRLADIДћIN FAKTLAR:\n' + memories.map(m => `- ${m.fact}`).join('\n') + '\n';
      }
    }
    let companySettingsText = '';
    const { data: companySettings } = await supabase.from('company_settings').select('sector,systems,approval_rules,approver_mapping,writing_tone,preferred_language').eq('company_id', employee.company_id).maybeSingle();
    if (companySettings) companySettingsText = `\nЕћД°RKЖЏT AYARLARI:\n- Sektor: ${companySettings.sector || 'qeyd edilmЙ™yib'}\n- SistemlЙ™r: ${Array.isArray(companySettings.systems) ? companySettings.systems.join(', ') : (companySettings.systems || 'qeyd edilmЙ™yib')}\n- TЙ™sdiq tЙ™lЙ™b edЙ™n Й™mЙ™liyyatlar: ${companySettings.approval_rules || 'qeyd edilmЙ™yib'}\n- TЙ™sdiqlЙ™yЙ™nlЙ™r: ${companySettings.approver_mapping || 'qeyd edilmЙ™yib'}\n- YazД± tonu: ${companySettings.writing_tone || 'peЕџЙ™kar'}\n- Dil: ${companySettings.preferred_language || 'az'}\n`;

    // 3.6) Real "availability" yoxlamasД± вЂ” bu iЕџГ§inin VERД°LЖЏNLЖЏR BAZASINDAKI bГјtГјn
    // gГ¶zlЙ™yЙ™n/tЙ™sdiqlЙ™nmiЕџ mЙ™zuniyyЙ™t tarixlЙ™rini gЙ™tiririk (yalnД±z sГ¶hbЙ™t yaddaЕџД±na gГјvЙ™nmЙ™k Й™vЙ™zinЙ™)
    const { data: existingLeaves } = await supabase
      .from('action_requests')
      .select('title, start_date, end_date, status')
      .eq('employee_id', employeeId)
      .eq('type', 'leave_request')
      .in('status', ['pending', 'approved']);

    const existingLeavesText = (existingLeaves && existingLeaves.length > 0)
      ? existingLeaves.map(l => `- ${l.start_date} вЂ” ${l.end_date} (${l.status === 'approved' ? 'tЙ™sdiqlЙ™nib' : 'gГ¶zlЙ™yir'}): ${l.title}`).join('\n')
      : '(bu iЕџГ§inin heГ§ bir aktiv mЙ™zuniyyЙ™t sorДџusu yoxdur)';

    // 3.65) ЖЏgЙ™r sual mЙ™zuniyyЙ™tlЙ™ Й™laqЙ™lidirsЙ™, REAL Google Calendar-da (nГ¶vbЙ™ti 60 gГјn) mЙ™ЕџДџulluДџu yoxla
    let calendarBusyText = '';
    if (/mezuniyy|mЙ™zuniyy|leave|vacation|tetil|tЙ™til/i.test(question)) {
      const now = new Date();
      const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      const busy = await checkCalendarAvailability(now.toISOString(), future.toISOString());
      if (busy && busy.length > 0) {
        calendarBusyText = `\nGOOGLE CALENDAR-DA MЖЏЕћДћUL VAXTLAR (nГ¶vbЙ™ti 60 gГјn, real tЙ™qvimdЙ™n):\n${busy.map(b => `- ${b.start} вЂ” ${b.end}`).join('\n')}\n`;
      } else if (busy) {
        calendarBusyText = '\nGOOGLE CALENDAR-DA MЖЏЕћДћUL VAXTLAR: (nГ¶vbЙ™ti 60 gГјndЙ™ heГ§ bir mЙ™ЕџДџulluq yoxdur)\n';
      }
    }

    // 3.7) ЖЏgЙ™r sual email haqqД±ndadД±rsa, real inbox-u oxu
    let emailsText = '';
    if (isEmailRelated(question)) {
      const emails = await readRecentEmails(employee.company_id);
      emailsText = emails.length > 0
        ? emails.map((e, i) => `${i + 1}. "${e.subject}" вЂ” ${e.fromName} (${e.fromEmail})\n   ${e.snippet}`).join('\n\n')
        : '(inbox oxunmadД± vЙ™ ya boЕџdur)';
    }

    // 3.8) ЕћirkЙ™t iЕџГ§ilЙ™rinin real email siyahД±sД± (Claude email ГјnvanД± UYDURMASIN deyЙ™)
    const { data: companyDirectory } = await supabase
      .from('employees')
      .select('name, email, role')
      .eq('company_id', employee.company_id)
      .eq('status', 'active');
    const directoryText = (companyDirectory || [])
      .filter(e => e.email)
      .map(e => `- ${e.name} (${e.role}): ${e.email}`)
      .join('\n');

    // 4) Д°cazЙ™ sГјzgЙ™cindЙ™n keГ§ir вЂ” iЕџГ§inin gГ¶rЙ™ bilmЙ™diyi sЙ™nЙ™dlЙ™ri Г§Д±xar
    const allowedChunks = filterByPermission(finalMatches, employee.role);

    // ЖЏgЙ™r tapД±lan parГ§alar arasД±nda mЙ™hdud (restricted) bir sЙ™nЙ™d varsa,
    // amma iЕџГ§inin buna icazЙ™si yoxdursa вЂ” bu, "tapД±lmadД±" yox, "icazЙ™ yoxdur" demЙ™kdir.
    // (DigЙ™r Й™laqЙ™siz-amma-icazЙ™li parГ§alarД±n da tapД±lmasД± bunu dЙ™yiЕџmЙ™mЙ™lidir.)
    const deniedButRelevant = (matches || []).some(
      chunk => chunk.restricted_to_roles
        && chunk.restricted_to_roles.length > 0
        && !chunk.restricted_to_roles.includes(employee.role)
    );

    // 5) Kontekst mЙ™tnini hazД±rla
    const contextText = allowedChunks
      .map(c => `[${c.document_title} вЂ” ${c.section_label || 'Гњmumi'}]\n${c.content}`)
      .join('\n\n');

    // STATIK hissЙ™ (hЙ™r sorДџuda EYNД° qalД±r) вЂ” bunu ayrД±ca saxlayД±rД±q ki, Anthropic-in Prompt Caching
    // funksiyasД± bunu "yadda saxlasД±n" vЙ™ hЙ™r dЙ™fЙ™ bunun ГјГ§Гјn tam qiymЙ™t Г¶dЙ™mЙ™yЙ™k
    const staticInstructions = `SЙ™n VUSERA Employee Copilot-san. YalnД±z AzЙ™rbaycan dilindЙ™ cavab ver.

QAYDALAR:
1. YalnД±z sЙ™nЙ™ verilЙ™n sЙ™nЙ™d parГ§alarД±na Й™saslan, uydurma.
2. ЖЏgЙ™r kontekst boЕџdursa vЙ™ ya sual bununla Й™laqЙ™li deyilsЙ™, "Bu mЙ™lumat mГ¶vcud bilik bazasД±nda tapД±lmadД±" de.
2.5. ЖЏgЙ™r istifadЙ™Г§i bir sЙ™nЙ™din ("bu sЙ™nЙ™di", "X sЙ™nЙ™dini") "xГјlasЙ™ et", "qД±saca izah et", "summary" istЙ™yirsЙ™, bГјtГјn mГјvafiq parГ§alarД± birlЙ™Еџdirib, sЙ™nЙ™din ЖЏSAS MЖЏZMUNUNU 3-5 cГјmlЙ™yЙ™ yД±ДџcamlaЕџdД±r (bГјtГјn Й™sas bГ¶lmЙ™lЙ™rЙ™ toxun, detala getmЙ™).
3. ЖЏMЖЏLД°YYAT (mЙ™zuniyyЙ™t/xЙ™rc/IT problemi) Д°KД° ADDIMLI PROSESDД°R:
   ADDIM 1 (TЙ™klif): Д°stifadЙ™Г§i ilk dЙ™fЙ™ bir iЕџ gГ¶rГјlmЙ™sini istЙ™yЙ™ndЙ™, lazД±mi mЙ™lumatД± (tarix, mЙ™blЙ™Дџ, problem) topla, XГњLASЖЏ ET vЙ™ aydД±n ЕџЙ™kildЙ™ TЖЏSDД°Q SORUЕћ (mЙ™s: "Bunu tЙ™sdiqlЙ™yirsinizmi?"). Bu addД±mda HEГ‡ VAXT ACTION yazma.
   Г–ZЖЏL QAYDA (IT Troubleshooting): ЖЏgЙ™r tip it_ticket-dirsЙ™ VЖЏ sЙ™nЙ™d parГ§alarД±nda (IT Security Policy vЙ™ s.) bu problemlЙ™ baДџlД± BASД°T, Г¶zГјn-et hЙ™ll addД±mlarД± varsa (mЙ™s: "ЕџЙ™bЙ™kЙ™yЙ™ qoЕџula bilmirЙ™m" в†’ "router-i yenidЙ™n baЕџlat" kimi bir addД±m sЙ™nЙ™ddЙ™ yazД±lД±bsa), ЖЏVVЖЏLCЖЏ bu addД±mД± tЙ™klif et vЙ™ "Bunu sД±nadД±nД±zmД±, kГ¶mЙ™k etdimi?" deyЙ™ soruЕџ вЂ” ticket-i DЖЏRHAL tЙ™klif ETMЖЏ. YalnД±z istifadЙ™Г§i "sД±nadД±m, kГ¶mЙ™k etmЙ™di" desЙ™, ADDIM 1-Й™ (ticket tЙ™klifinЙ™) keГ§.
   ЖЏGЖЏR TД°P leave_request-dirsЙ™: mГ¶vcud mЙ™zuniyyЙ™t sorДџularД± VЖЏ Google Calendar-dakД± mЙ™ЕџДџul vaxtlar ilЙ™ TARД°X ГњST-ГњSTЖЏ DГњЕћMЖЏSД°NД° yoxla, Гјst-ГјstЙ™ dГјЕџmЙ™ varsa bunu AГ‡IQ ЕџЙ™kildЙ™ xЙ™bЙ™rdarlД±q et (tЙ™sdiq soruЕџarkЙ™n).
   ADDIM 2 (TЙ™sdiq): YalnД±z Й™gЙ™r sГ¶hbЙ™tin ЖЏVVЖЏLKД° sЙ™nin mesajД±nda artД±q tЙ™klif irЙ™li sГјrmГјsЙ™nsЙ™ VЖЏ istifadЙ™Г§i indi "bЙ™li/hЙ™/tЙ™sdiqlЙ™yirЙ™m/et" kimi razД±lД±q bildirirsЙ™, cavabД±nД±n sonunda bunu yaz: ACTION:{"type":"leave_request|it_ticket|expense_request","title":"...","detail":"...","priority":"low|normal|high","category":"...","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","amount":rЙ™qЙ™m_ve_ya_null}
   Д°stifadЙ™Г§i "yox" desЙ™ vЙ™ ya fikrini dЙ™yiЕџsЙ™, ACTION yazma, "LЙ™Дџv edildi" de.
   VACД°B: ACTION marker-i yazД±rsansa, o, cavabД±nД±n MГњTLЖЏQ SON HД°SSЖЏSД° olmalД±dД±r вЂ” ondan sonra HEГ‡ BД°R sГ¶z, HEГ‡ BД°R salamlama, HEГ‡ BД°R emoji yazma.
   Г‡OX-ADDIMLI TAPЕћIRIQ DЖЏSTЖЏYД°: ЖЏgЙ™r istifadЙ™Г§i tapЕџД±rД±qla YANAЕћI, kimЙ™sЙ™ bu barЙ™dЙ™ email ilЙ™ xЙ™bЙ™r verilmЙ™sini dЙ™ istЙ™yirsЙ™ (mЙ™s: "IT ticket yarat VЖЏ Michael-Й™ dЙ™ bildir"), ACTION obyektinЙ™ Й™lavЙ™ "notifyEmail" (real direktoriya email ГјnvanД±) vЙ™ "notifyNote" (qД±sa bildiriЕџ mЙ™tni) sahЙ™lЙ™rini Й™lavЙ™ et вЂ” sistem Й™sas Й™mЙ™liyyatdan SONRA avtomatik bu email-i dЙ™ gГ¶ndЙ™rЙ™cЙ™k.
   ЖЏLAVЖЏ: ЖЏgЙ™r istifadЙ™Г§i "Slack-Й™ dЙ™ yaz/bildir" desЙ™, VACД°B: ADDIM 2-dЙ™ (tЙ™sdiqdЙ™n sonra), ACTION JSON-un Д°Г‡Д°NЖЏ MГњTLЖЏQ "notifySlackChannel" (mЙ™s: "#all-vusera") vЙ™ "notifySlackNote" sahЙ™lЙ™rini dЙ™ yaz вЂ” bunu unutma, Г§Гјnki bu, ADDIM 1-dЙ™ vЙ™d etdiyin bir iЕџdir. MЙ™sЙ™lЙ™n: ACTION:{"type":"it_ticket",...,"notifySlackChannel":"#all-vusera","notifySlackNote":"Yeni IT ticket: Laptop iЕџlЙ™mir"}
   ЖЏLAVЖЏ (CRM): ЖЏgЙ™r istifadЙ™Г§i "CRM-dЙ™ yeni mГјЕџtЙ™ri yarat", "kontakt Й™lavЙ™ et" kimi bir Еџey istЙ™yirsЙ™, 2-addД±mlД± prosesЙ™ tabedir: ADDIM 1-dЙ™ ad/soyad/email/telefon/ЕџirkЙ™ti aydД±nlaЕџdД±r, tЙ™sdiq soruЕџ; ADDIM 2-dЙ™: ACTION:{"type":"create_crm_contact","firstname":"...","lastname":"...","email":"...","phone":"... vЙ™ ya null","company":"... vЙ™ ya null","title":"CRM Kontakt YaradД±ldД±","detail":"..."}
   - leave_request ГјГ§Гјn category: "annual" | "sick" | "unpaid" | "emergency"; start_date/end_date MГњTLЖЏQ doldurulmalД±dД±r
   - it_ticket ГјГ§Гјn category: "hardware" | "software" | "access" | "network"; priority: problemi ciddiliyinЙ™ gГ¶rЙ™ seГ§ (mes: "iЕџlЙ™mir" = high, "yavaЕџdД±r" = normal); start_date/end_date lazД±m deyil, boЕџ buraxa bilЙ™rsЙ™n
   - expense_request ГјГ§Гјn category: "travel" | "meals" | "office" | "other"; start_date/end_date lazД±m deyil; "amount" sahЙ™sinЙ™ MГњTLЖЏQ rЙ™qЙ™m (yalnД±z Й™dЙ™d, valyuta olmadan) yaz, mЙ™s: 2500
   ЖЏLAVЖЏ (Email): ЖЏgЙ™r istifadЙ™Г§i email GГ–NDЖЏRMЖЏK istЙ™yirsЙ™, 2-addД±mlД± prosesЙ™ tabedir: ADDIM 1-dЙ™ draft-Д± gГ¶stЙ™r, tЙ™sdiq soruЕџ; ADDIM 2-dЙ™: ACTION:{"type":"send_email","to":"email@ГјnvanД±","subject":"...","title":"Email gГ¶ndЙ™rildi","detail":"..."}
   VACД°B: "to" sahЙ™si YA ЕџirkЙ™t iЕџГ§i direktoriyasД±ndakД±, YA DA "SON EMAД°LLЖЏR" bГ¶lmЙ™sindЙ™ gГ¶stЙ™rilЙ™n (yЙ™ni artД±q bizЙ™ yazmД±Еџ) real bir Гјnvan ola bilЙ™r вЂ” bu, xarici insanlara (mГјЕџtЙ™ri, tЙ™lЙ™bЙ™ vЙ™ s.) cavab yazmaДџa imkan verir. HeГ§ bir uydurma Гјnvan istifadЙ™ etmЙ™ вЂ” yuxarД±dakД± iki mЙ™nbЙ™dЙ™n birindЙ™ olmayan Гјnvan ГјГ§Гјn, "Bu ЕџЙ™xsin email ГјnvanД± sistemdЙ™ tapД±lmadД±" de.
   ЖЏLAVЖЏ (GГ¶rГјЕџ): ЖЏgЙ™r istifadЙ™Г§i gГ¶rГјЕџ/meeting yaratmaq istЙ™yirsЙ™ ("sabah 3-dЙ™ gГ¶rГјЕџ qur" kimi), 2-addД±mlД± prosesЙ™ tabedir: ADDIM 1-dЙ™ tarix/saat/baЕџlД±ДџД± gГ¶stЙ™r, tЙ™sdiq soruЕџ; ADDIM 2-dЙ™: ACTION:{"type":"create_meeting","title":"...","startDateTime":"YYYY-MM-DDTHH:mm:00+04:00","endDateTime":"YYYY-MM-DDTHH:mm:00+04:00","description":"..."}
   ЖЏLAVЖЏ (Гњmumi tapЕџД±rД±q): ЖЏgЙ™r istifadЙ™Г§i "tapЕџД±rД±q kimi yarat", "task yarat", "mЙ™nЙ™ xatД±rlat" vЙ™ ya konkret iЕџi planlaЕџdД±rmaq istЙ™yirsЙ™, tЙ™sdiq tЙ™lЙ™b etmЙ™dЙ™n ACTION:{"type":"create_task","title":"...","detail":"...","priority":"A|B|C","due_at":"YYYY-MM-DDTHH:mm:00+04:00","status":"today|waiting","next_step":"..."} yaz. Tarix verilmЙ™yibsЙ™ due_at=null vЙ™ status="waiting" olsun. Bu, email gГ¶ndЙ™rmЙ™k deyil, yalnД±z task center-dЙ™ tapЕџД±rД±q yaratmaqdД±r.
   (Vaxt zonasД± hЙ™miЕџЙ™ +04:00 (BakД±) olsun, bitmЙ™ vaxtД± gГ¶stЙ™rilmЙ™zsЙ™ baЕџlanДџД±cdan 30 dЙ™qiqЙ™ sonra qЙ™bul et)
   ЖЏLAVЖЏ (GГ¶rГјЕџГј lЙ™Дџv etmЙ™): ЖЏgЙ™r istifadЙ™Г§i bir gГ¶rГјЕџГј lЙ™Дџv etmЙ™k istЙ™yirsЙ™, 2-addД±mlД± prosesЙ™ tabedir: ADDIM 1-dЙ™ hansД± gГ¶rГјЕџГј lЙ™Дџv edЙ™cЙ™yini aydД±nlaЕџdД±r, tЙ™sdiq soruЕџ; ADDIM 2-dЙ™: ACTION:{"type":"cancel_meeting","titleMatch":"gГ¶rГјЕџГјn baЕџlД±ДџД±ndan aГ§ar sГ¶z","title":"LЙ™Дџv edildi","detail":"..."}
   ЖЏLAVЖЏ (GГ¶rГјЕџГјn vaxtД±nД± dЙ™yiЕџmЙ™): ЖЏgЙ™r istifadЙ™Г§i bir gГ¶rГјЕџГјn vaxtД±nД± dЙ™yiЕџmЙ™k istЙ™yirsЙ™ ("gorГјЕџГј sabaha kГ¶Г§Гјr" kimi), 2-addД±mlД± prosesЙ™ tabedir: ADDIM 1-dЙ™ hansД± gГ¶rГјЕџ vЙ™ yeni vaxtД± aydД±nlaЕџdД±r, tЙ™sdiq soruЕџ; ADDIM 2-dЙ™: ACTION:{"type":"reschedule_meeting","titleMatch":"gГ¶rГјЕџГјn baЕџlД±ДџД±ndan aГ§ar sГ¶z","newStartDateTime":"YYYY-MM-DDTHH:mm:00+04:00","newEndDateTime":"YYYY-MM-DDTHH:mm:00+04:00","title":"Vaxt dЙ™yiЕџdirildi","detail":"..."}
   ЖЏLAVЖЏ (Hesabat): ЖЏgЙ™r istifadЙ™Г§i hesabat/report istЙ™yirsЙ™ ("bu ayД±n IT ticketlЙ™rinin hesabatД±nД± hazД±rla" kimi), 2-addД±mlД± prosesЙ™ tabedir: ADDIM 1-dЙ™ nЙ™yi Й™hatЙ™ edЙ™cЙ™yini (nГ¶v, status, mГјddЙ™t) gГ¶stЙ™r VЖЏ format seГ§imini soruЕџ (PDF, yoxsa Google Sheets); ADDIM 2-dЙ™: ACTION:{"type":"generate_report","title":"Hesabat baЕџlД±ДџД±","reportType":"leave_request|it_ticket|expense_request vЙ™ ya boЕџ (hamД±sД±)","reportStatus":"pending|approved|rejected vЙ™ ya boЕџ (hamД±sД±)","sinceDays":30,"format":"pdf|sheets"}
   ЖЏLAVЖЏ (Kollegaya mesaj): ЖЏgЙ™r istifadЙ™Г§i "filan ЕџЙ™xsЙ™ deyin ki...", "filan ЕџЙ™xsЙ™ mesaj gГ¶ndЙ™r" kimi bir Еџey desЙ™, dЙ™rhal (tЙ™sdiq soruЕџmadan): ACTION:{"type":"send_message","recipientName":"qЙ™bul edЙ™nin adД± (mЙ™tndЙ™ deyildiyi kimi)","message":"Г¶tГјrГјlЙ™cЙ™k mesajД±n mЙ™zmunu"}
   ЖЏLAVЖЏ (SЙ™nЙ™d MГјqayisЙ™si вЂ” PREMIUM): ЖЏgЙ™r istifadЙ™Г§i 2 sЙ™nЙ™di mГјqayisЙ™ etmЙ™k istЙ™sЙ™ ("bu iki mГјqavilЙ™ni mГјqayisЙ™ et" kimi), dЙ™rhal: ACTION:{"type":"compare_documents","doc1Title":"birinci sЙ™nЙ™din baЕџlД±ДџД± (mЙ™tndЙ™ deyildiyi kimi)","doc2Title":"ikinci sЙ™nЙ™din baЕџlД±ДџД±"}
   ЖЏLAVЖЏ (GГ¶rГјЕџ HazД±rlД±ДџД± вЂ” PREMIUM): ЖЏgЙ™r istifadЙ™Г§i bir gГ¶rГјЕџЙ™ hazД±rlanmaq istЙ™sЙ™ ("mЙ™ni sabahkД± gГ¶rГјЕџЙ™ hazД±rla", "filan gГ¶rГјЕџЙ™ hazД±rlД±q" kimi), dЙ™rhal: ACTION:{"type":"meeting_prep","meetingTitleOrPerson":"gГ¶rГјЕџГјn baЕџlД±ДџД± vЙ™ ya iЕџtirakГ§Д±nД±n adД± (mЙ™tndЙ™ deyildiyi kimi)"}
   ЖЏLAVЖЏ (AДџД±llД± yaddaЕџ): ЖЏgЙ™r istifadЙ™Г§i "bunu xatД±rla", "bunu qeyd et" kimi bir Еџey desЙ™, VЖЏ YA tЙ™krarlanan vЙ™ gЙ™lЙ™cЙ™kdЙ™ faydalД± olacaq ГјstГјnlГјk/vЙ™rdiЕџ bildirsЙ™, cavabД±nД±n sonunda (ACTION-dan AYRI, Г¶z sЙ™trindЙ™) bunu yaz: REMEMBER:{"fact":"qД±sa, aydД±n bir cГјmlЙ™ ilЙ™ fakt"}. HЙ™r cavabda deyil, yalnД±z hЙ™qiqЙ™tЙ™n faydalД± fakt ГјГ§Гјn yaz.
   (Д°stifadЙ™Г§i "excel", "sheets", "cЙ™dvЙ™l" desЙ™ format="sheets"; "PDF" vЙ™ ya heГ§ nЙ™ demЙ™sЙ™ format="pdf")
4. Adi cavab ГјГ§Гјn sonunda: SOURCE: SЙ™nЙ™d adД± вЂ” Section X.X
5. QД±sa, 2-4 cГјmlЙ™.
6. ЖЏgЙ™r "SON EMAД°LLЖЏR" bГ¶lmЙ™si verilibsЙ™, istifadЙ™Г§i bunlarД± xГјlasЙ™ etmЙ™yi istЙ™yirsЙ™, hЙ™r emaili 1 sЙ™tirdЙ™ (kimdЙ™n, mГ¶vzu) yД±Дџcam gГ¶stЙ™r, VЖЏ hЙ™r emailin qarЕџД±sД±na kateqoriya etiketi Й™lavЙ™ et: рџ”ґ TЙ™cili (fЙ™aliyyЙ™t tЙ™lЙ™b edЙ™n/vaxt hЙ™ssas), рџ”µ Д°nformasiya (sadЙ™cЙ™ bilgi), рџџў Marketinq/Newsletter. KateqoriyayД± emailД±n mГ¶vzusuna/mЙ™zmununa gГ¶rЙ™ Г¶zГјn mГјЙ™yyЙ™n et.
6.5. ЖЏgЙ™r istifadЙ™Г§i bir email ГјГ§Гјn "follow-up yarat", "xatД±rlat" desЙ™, 2-addД±mlД± prosesЙ™ tabedir: ADDIM 1-dЙ™ hansД± email vЙ™ neГ§Й™ gГјndЙ™n sonra xatД±rladД±lacaДџД±nД± aydД±nlaЕџdД±r, tЙ™sdiq soruЕџ; ADDIM 2-dЙ™: ACTION:{"type":"email_followup","emailSubject":"email mГ¶vzusu","daysLater":3,"title":"Email Follow-up PlanlaЕџdД±rД±ldД±","detail":"..."}
7. ЖЏgЙ™r sЙ™n REJД°M A (adi sual-cavab) ilЙ™ cavab verirsЙ™nsЙ™ VЖЏ cavabД±ndan mЙ™ntiqli, tЙ™bii bir davam Й™mЙ™liyyatД± Г§Д±xД±rsa (mЙ™s: "MЙ™zuniyyЙ™t qaydasД±" sualД±ndan sonra вЂ” "istЙ™yirsiniz mЙ™zuniyyЙ™t sorДџusu yaradД±m?"; "IT Security Policy" sualД±ndan sonra вЂ” "IT problemi bildirmЙ™k istЙ™yirsiniz?"), cavabД±nД±n SONUNDA (SOURCE-dan da sonra) yeni sЙ™tirdЙ™ bunu Й™lavЙ™ et: SUGGESTION: qД±sa tЙ™klif mЙ™tni (mЙ™s: "MЙ™zuniyyЙ™t sorДџusu yaratmaДџД±mД± istЙ™yirsiniz?")
   Bunu YALNIZ real, tЙ™bii bir davam varsa yaz вЂ” hЙ™r cavabda mЙ™cburi deyil, Й™ksinЙ™ Й™ksЙ™r sadЙ™ faktual suallarda heГ§ bir tЙ™klif YAZMA.

WEB AXTARIЕћI: SЙ™nin bir "web_search" alЙ™tin var. Bunu YALNIZ istifadЙ™Г§inin sualД±, ЕџirkЙ™t sЙ™nЙ™dlЙ™rindЙ™/daxili mЙ™lumatda TAPILA BД°LMЖЏYЖЏCЖЏK, kЙ™nar/Гјmumi/gГјncЙ™l bir mЙ™lumat tЙ™lЙ™b etdikdЙ™ istifadЙ™ et (mЙ™s: "USD mЙ™zЙ™nnЙ™si neГ§Й™dir?", "bu ЕџirkЙ™t kimdir?", "hava necЙ™dir?"). ЕћirkЙ™tin Г¶z daxili siyasЙ™tlЙ™ri/sorДџularД± haqqД±nda suallarda, HEГ‡ VAXT web axtarД±ЕџД± ETMЖЏ вЂ” yalnД±z sЙ™nЙ™ verilЙ™n bilik bazasД±ndan istifadЙ™ et.`;

    // DД°NAMД°K hissЙ™ (hЙ™r sorДџuda dЙ™yiЕџir) вЂ” keЕџlЙ™nmir, hЙ™r dЙ™fЙ™ tam gГ¶ndЙ™rilir
    const dynamicContext = `Д°stifadЙ™Г§i: ${employee.name}, ${employee.departments?.name || ''}, rol: ${employee.role}.
${employeeMemoryText}${companySettingsText}
BUGГњNKГњ TAM TARД°X VЖЏ SAAT: ${new Date().toLocaleString('az-AZ', { timeZone: 'Asia/Baku', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (BakД± vaxtД±). "BugГјn", "sabah", "gЙ™lЙ™n hЙ™ftЙ™" kimi ifadЙ™lЙ™ri HЖЏMД°ЕћЖЏ bu tarixЙ™ Й™sasЙ™n hesabla вЂ” heГ§ vaxt kГ¶hnЙ™ vЙ™ ya tЙ™xmini il istifadЙ™ etmЙ™.

AЕџaДџД±da bu sualla Й™laqЙ™li, sistemin indi tapdД±ДџД± sЙ™nЙ™d parГ§alarД± var (Й™gЙ™r sГ¶hbЙ™tin Й™vvЙ™lki hissЙ™si varsa, onu da nЙ™zЙ™rЙ™ al вЂ” mЙ™sЙ™lЙ™n "bЙ™s neГ§Й™ gГјn?" kimi davam suallarД±):
${contextText || '(bu sual ГјГ§Гјn uyДџun yeni sЙ™nЙ™d tapД±lmadД± вЂ” Й™vvЙ™lki sГ¶hbЙ™tЙ™ Й™saslana bilЙ™rsЙ™n, Й™ks halda tapД±lmadД±ДџД±nД± de)'}

MГ–VCUD MЖЏZUNД°YYЖЏT SORДћULARI (bu iЕџГ§inin, verilЙ™nlЙ™r bazasД±ndan вЂ” real tarix Гјst-ГјstЙ™ dГјЕџmЙ™sini yoxlamaq ГјГ§Гјn):
${existingLeavesText}
${calendarBusyText}

${emailsText ? `SON EMAД°LLЖЏR (Gmail-dЙ™n indi oxunub):\n${emailsText}\n` : ''}

ЕћД°RKЖЏT Д°ЕћГ‡Д° DД°REKTORД°YASI (real email ГјnvanlarД± вЂ” email gГ¶ndЙ™rЙ™ndЙ™ YALNIZ buradakД± Гјnvanlardan istifadЙ™ et, HEГ‡ VAXT Гјnvan uydurma):
${directoryText || '(direktoriya boЕџdur)'}`;

    // 6) Claude-dan cavab al (sГ¶hbЙ™t tarixГ§Й™si ilЙ™ birlikdЙ™) вЂ” bir cЙ™hd
    // Qerar: Haiku yonlendirmesi legv edildi - butun sorgular Sonnet-de qalir (etibarlilq ustunluk teskil edir),
    // xerc idareetmesi bunun evezine QIYMET ve TOKEN LIMITI vasitesile aparilir
    let message;
    try {
      message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: [
          { type: 'text', text: staticInstructions, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicContext }
        ],
        messages: conversationMessages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      });
    } catch (e) {
      console.error('Anthropic API xЙ™tasД±:', e.message);
      return res.status(503).json({ error: 'VUSERA hazД±rda cavab verЙ™ bilmir. Bir neГ§Й™ saniyЙ™ sonra yenidЙ™n cЙ™hd edin.' });
    }

    let answerText = message.content.map(b => b.text || '').join('');
    // DIAQNOSTIKA: Prompt Caching-in real isleyib-islemediyini derhal Render logР»Р°СЂinda goremek ucun
    if (message.usage) {
      console.log(`[CACHE DEBUG] cache_creation: ${message.usage.cache_creation_input_tokens || 0}, cache_read: ${message.usage.cache_read_input_tokens || 0}, input: ${message.usage.input_tokens}`);
    }
    let sourceType = 'answer';
    let createdAction = null;

    if (deniedButRelevant) {
      answerText = 'Bu mЙ™lumat ГјГ§Гјn icazЙ™niz yoxdur.';
      sourceType = 'denied';
    } else {
      // Cavabda bir "ACTION" (mЙ™zuniyyЙ™t/ticket/xЙ™rc sorДџusu) var mД± yoxla
      // PREMIUM: "REMEMBER:" iЕџarЙ™sini tap, saxla, mЙ™tndЙ™n sil (istifadЙ™Г§iyЙ™ gГ¶stЙ™rilmЙ™sin)
      const rememberMatch = answerText.match(/REMEMBER:\s*(\{.*?\})/s);
      if (rememberMatch && isPremiumCompany) {
        try {
          const rememberData = JSON.parse(rememberMatch[1]);
          if (rememberData.fact) {
            await supabase.from('employee_memory').insert({
              employee_id: employeeId, company_id: employee.company_id, fact: rememberData.fact
            });
          }
        } catch (e) { /* JSON sЙ™hvdirsЙ™, sadЙ™cЙ™ saxlamД±rД±q */ }
        answerText = answerText.replace(/REMEMBER:\s*\{.*?\}/s, '').trim();
      }

      const actionMatch = answerText.match(/ACTION:\s*(\{.*?\})/s);
      if (actionMatch) {
        try {
          const actionData = JSON.parse(actionMatch[1]);
          answerText = answerText.replace(/ACTION:\s*\{.*?\}/s, '').trim();
          sourceType = 'action';
          if (!answerText) answerText = 'SorДџunuz emal edilir...'; // Claude yalnД±z ACTION yazД±bsa, boЕџ qalmasД±n

          // ---- IDEMPOTENCY YOXLAMASI вЂ” eyni Й™mЙ™liyyatД±n tЙ™sadГјfЙ™n 2 dЙ™fЙ™ icra olunmasД±nД±n qarЕџД±sД±nД± alД±r ----
          // Qeyd: "sorДџu" tipli (read-only) Й™mЙ™liyyatlar (meeting_prep, compare_documents) bu yoxlamadan azaddД±r вЂ”
          // bunlar heГ§ bir dЙ™yiЕџiklik etmir, tЙ™krar sorulmasД± zЙ™rЙ™rsizdir, hЙ™tta faydalД± ola bilЙ™r (yeni mЙ™lumatla)
          const idempotencyExemptTypes = ['meeting_prep', 'compare_documents'];
          const fingerprint = crypto.createHash('sha256')
            .update(`${employee.id}:${actionData.type}:${actionData.title || ''}:${JSON.stringify(actionData)}`)
            .digest('hex');
          const sixtySecondsAgo = new Date(Date.now() - 60 * 1000).toISOString();
          const existingFingerprint = idempotencyExemptTypes.includes(actionData.type) ? null : (await supabase
            .from('action_fingerprints')
            .select('id')
            .eq('fingerprint', fingerprint)
            .eq('employee_id', employee.id)
            .gte('created_at', sixtySecondsAgo)
            .maybeSingle()).data;

          if (existingFingerprint) {
            // Bu, artД±q son 60 saniyЙ™dЙ™ icra olunub вЂ” TЖЏKRAR ETMЖЏ, sadЙ™cЙ™ xЙ™bЙ™r ver
            createdAction = {
              id: 'duplicate-' + Date.now(),
              type: actionData.type,
              title: 'Bu Й™mЙ™liyyat artД±q icra olunub',
              detail: 'TЙ™krar sorДџunun qarЕџД±sД± alД±ndД± (son 60 saniyЙ™ Й™rzindЙ™ eyni Й™mЙ™liyyat aЕџkarlandД±).',
              status: 'duplicate_prevented'
            };
          } else {
            // Barmaq izini qeydЙ™ al ki, tЙ™krarД±nД± tanД±ya bilЙ™k
            if (!idempotencyExemptTypes.includes(actionData.type)) {
              await supabase.from('action_fingerprints').insert({ fingerprint, employee_id: employee.id });
            }

          if (actionData.type === 'send_email') {
            // Email gГ¶ndЙ™rmЙ™ - approval axД±nД±na yox, birbaЕџa Make.com-a gedir
            const emailResult = await sendEmailViaMake(employee.company_id, actionData.to, actionData.subject, actionData.detail || actionData.body || '');
            createdAction = {
              id: 'email-' + Date.now(),
              type: 'send_email',
              title: emailResult.success ? `Email gГ¶ndЙ™rildi: ${actionData.to}` : 'Email gГ¶ndЙ™rilmЙ™di',
              detail: actionData.subject || '',
              status: emailResult.success ? 'sent' : 'failed'
            };
          } else if (actionData.type === 'create_task') {
            const due = actionData.due_at ? new Date(actionData.due_at) : null;
            const status = actionData.status || (due && due.toDateString() === new Date().toDateString() ? 'today' : 'waiting');
            const taskResult = await supabase.from('tasks').insert({
              company_id: employee.company_id, employee_id: employee.id,
              title: actionData.title || 'Yeni tapЕџД±rД±q', detail: actionData.detail || null,
              priority: actionData.priority || 'B', due_at: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null,
              status, next_step: actionData.next_step || null, source: 'chat'
            }).select().single();
            createdAction = { id: taskResult.data?.id || 'task-' + Date.now(), type: 'create_task', title: taskResult.error ? 'TapЕџД±rД±q yaradД±la bilmЙ™di' : `TapЕџД±rД±q yaradД±ldД±: ${actionData.title}`, detail: taskResult.error?.message || actionData.due_at || '', status: taskResult.error ? 'failed' : 'created' };
          } else if (actionData.type === 'create_meeting') {
            // GГ¶rГјЕџ yaratma - approval axД±nД±na yox, birbaЕџa Google Calendar-a gedir
            const meetingResult = await createMeetingDirectGoogle(employee.company_id, actionData.title, actionData.startDateTime, actionData.endDateTime, actionData.description || '');
            if (meetingResult.success) {
              await supabase.from('meetings').insert({
                company_id: employee.company_id,
                employee_id: employee.id,
                title: actionData.title,
                start_datetime: actionData.startDateTime,
                end_datetime: actionData.endDateTime,
                calendar_event_id: meetingResult.eventId,
                status: 'active'
              });
            }

            // Meeting Preparation вЂ” gГ¶rГјЕџГјn baЕџlД±ДџД±na uyДџun sЙ™nЙ™dlЙ™ri axtarД±b, hazД±rlД±q materialД± kimi Й™lavЙ™ edirik
            let prepNote = '';
            try {
              const titleEmbedding = await getEmbedding(actionData.title);
              const { data: prepMatches } = await supabase.rpc('match_chunks', {
                query_embedding: titleEmbedding,
                match_company_id: employee.company_id,
                match_count: 2
              });
              if (prepMatches && prepMatches.length > 0 && prepMatches[0].similarity > 0.5 && prepMatches[0].section_label) {
                prepNote = ` В· HazД±rlД±q: "${prepMatches[0].section_label}" sЙ™nЙ™dinЙ™ baxД±n`;
              }
            } catch (e) { /* prep axtarД±ЕџД± uДџursuz olsa, sakitcЙ™ keГ§ */ }

            createdAction = {
              id: 'meeting-' + Date.now(),
              type: 'create_meeting',
              title: meetingResult.success ? actionData.title : 'GГ¶rГјЕџ yaradД±lmadД±',
              detail: (actionData.startDateTime || '') + prepNote,
              status: meetingResult.success ? 'created' : 'failed'
            };
          } else if (actionData.type === 'cancel_meeting') {
            // GГ¶rГјЕџГј lЙ™Дџv etmЙ™ - baЕџlД±q/tarixЙ™ uyДџun aktiv gГ¶rГјЕџГј tapД±b Calendar-dan silir
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
              const cancelResult = await cancelMeetingDirectGoogle(employee.company_id, matchingMeeting.calendar_event_id);
              if (cancelResult.success) {
                await supabase.from('meetings').update({ status: 'cancelled' }).eq('id', matchingMeeting.id);
              }
              createdAction = {
                id: 'cancel-' + Date.now(),
                type: 'cancel_meeting',
                title: cancelResult.success ? `LЙ™Дџv edildi: ${matchingMeeting.title}` : 'LЙ™Дџv edilmЙ™di',
                detail: matchingMeeting.title,
                status: cancelResult.success ? 'cancelled' : 'failed'
              };
            } else {
              createdAction = {
                id: 'cancel-' + Date.now(),
                type: 'cancel_meeting',
                title: 'GГ¶rГјЕџ tapД±lmadД±',
                detail: 'UyДџun aktiv gГ¶rГјЕџ tapД±lmadД±',
                status: 'failed'
              };
            }
          } else if (actionData.type === 'email_followup') {
            // Email follow-up planlaЕџdД±rma - gЙ™lЙ™cЙ™k tarixli xatД±rlatma yaradД±r (meetings cЙ™dvЙ™lini yenidЙ™n istifadЙ™ edЙ™rЙ™k)
            const followUpDate = new Date(Date.now() + (actionData.daysLater || 3) * 24 * 60 * 60 * 1000);
            await supabase.from('meetings').insert({
              company_id: employee.company_id,
              employee_id: employee.id,
              title: `рџ“§ Follow-up: ${actionData.emailSubject}`,
              start_datetime: followUpDate.toISOString(),
              status: 'active'
            });
            createdAction = {
              id: 'followup-' + Date.now(),
              type: 'email_followup',
              title: `Follow-up PlanlaЕџdД±rД±ldД±: ${actionData.emailSubject}`,
              detail: `${actionData.daysLater || 3} gГјndЙ™n sonra xatД±rladД±lacaq`,
              status: 'created'
            };
          } else if (actionData.type === 'create_crm_contact') {
            // CRM Kontakt yaratma - birbaЕџa HubSpot API-sinЙ™ gedir
            const crmResult = await createHubSpotContact(employee.company_id, actionData.firstname, actionData.lastname, actionData.email, actionData.phone, actionData.company);
            createdAction = {
              id: 'crm-' + Date.now(),
              type: 'create_crm_contact',
              title: crmResult.success ? `CRM Kontakt: ${actionData.firstname} ${actionData.lastname}` : 'CRM Kontakt yaradД±lmadД±',
              detail: crmResult.success ? (actionData.company || actionData.email || '') : (crmResult.error || ''),
              status: crmResult.success ? 'created' : 'failed'
            };
          } else if (actionData.type === 'reschedule_meeting') {
            // GГ¶rГјЕџГјn vaxtД±nД± dЙ™yiЕџmЙ™ - kГ¶hnЙ™ni Calendar-dan silib, yenisini yeni vaxtda yaradД±r
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
              // 1) KГ¶hnЙ™ hadisЙ™ni sil
              await cancelMeetingDirectGoogle(employee.company_id, matchingMeeting.calendar_event_id);
              await supabase.from('meetings').update({ status: 'cancelled' }).eq('id', matchingMeeting.id);

              // 2) Yeni vaxtda yenisini yarat
              const meetingResult = await createMeetingDirectGoogle(employee.company_id, matchingMeeting.title, actionData.newStartDateTime, actionData.newEndDateTime, matchingMeeting.title);
              if (meetingResult.success) {
                await supabase.from('meetings').insert({
                  company_id: employee.company_id,
                  employee_id: employee.id,
                  title: matchingMeeting.title,
                  start_datetime: actionData.newStartDateTime,
                  end_datetime: actionData.newEndDateTime,
                  calendar_event_id: meetingResult.eventId
                });
              }
              createdAction = {
                id: 'reschedule-' + Date.now(),
                type: 'reschedule_meeting',
                title: meetingResult.success ? `VaxtД± dЙ™yiЕџdirildi: ${matchingMeeting.title}` : 'Vaxt dЙ™yiЕџdirilmЙ™di',
                detail: meetingResult.success ? `Yeni vaxt: ${actionData.newStartDateTime}` : '',
                status: meetingResult.success ? 'rescheduled' : 'failed'
              };
            } else {
              createdAction = {
                id: 'reschedule-' + Date.now(),
                type: 'reschedule_meeting',
                title: 'GГ¶rГјЕџ tapД±lmadД±',
                detail: 'UyДџun aktiv gГ¶rГјЕџ tapД±lmadД±',
                status: 'failed'
              };
            }
          } else if (actionData.type === 'meeting_prep') {
            // PREMIUM: GГ¶rГјЕџ + Й™laqЙ™li email-lЙ™ri tapД±b, Claude ilЙ™ brifinq hazД±rladД±r
            const { data: companyForPrep } = await supabase.from('companies').select('plan_name').eq('id', employee.company_id).single();
            if (companyForPrep?.plan_name !== 'Premium') {
              createdAction = { id: null, type: 'meeting_prep', title: 'Bu funksiya Premium plan tЙ™lЙ™b edir', detail: 'GГ¶rГјЕџ hazД±rlД±ДџД±, yalnД±z Premium planlД± ЕџirkЙ™tlЙ™r ГјГ§ГјndГјr.', priority: 'normal', status: 'failed' };
            } else {
              const { data: matchMeeting } = await supabase
                .from('meetings')
                .select('*')
                .eq('employee_id', employee.id)
                .eq('status', 'active')
                .ilike('title', `%${actionData.meetingTitleOrPerson}%`)
                .order('start_datetime', { ascending: true })
                .limit(1)
                .maybeSingle();

              const relatedEmails = await readRecentEmailsDirect(employee.company_id);
              const matchingEmails = relatedEmails.filter(e =>
                (e.fromName || '').toLowerCase().includes(actionData.meetingTitleOrPerson.toLowerCase()) ||
                (e.subject || '').toLowerCase().includes(actionData.meetingTitleOrPerson.toLowerCase())
              ).slice(0, 5);

              const prepMsg = await anthropic.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 600,
                messages: [{ role: 'user', content: `AЕџaДџД±dakД± mЙ™lumatlara Й™sasЙ™n, "${actionData.meetingTitleOrPerson}" ilЙ™ Й™laqЙ™li gГ¶rГјЕџ ГјГ§Гјn qД±sa bir hazД±rlД±q brifinqi yaz (AzЙ™rbaycan dilindЙ™, maddЙ™lЙ™r halД±nda):\n\nGГ¶rГјЕџ mЙ™lumatД±: ${matchMeeting ? JSON.stringify({title: matchMeeting.title, time: matchMeeting.start_datetime}) : 'TapД±lmadД±'}\n\nЖЏlaqЙ™li son email-lЙ™r: ${matchingEmails.length > 0 ? JSON.stringify(matchingEmails.map(e => ({from: e.fromName, subject: e.subject, snippet: e.snippet}))) : 'TapД±lmadД±'}` }]
              });
              const prepText = prepMsg.content.map(b => b.text || '').join('');
              createdAction = { id: null, type: 'meeting_prep', title: `GГ¶rГјЕџ HazД±rlД±ДџД±: ${actionData.meetingTitleOrPerson}`, detail: prepText, priority: 'normal', status: 'completed' };
            }
          } else if (actionData.type === 'compare_documents') {
            // PREMIUM: 2 sЙ™nЙ™di tapД±b, Claude ilЙ™ mГјqayisЙ™ etdirir
            const { data: companyForCompare } = await supabase.from('companies').select('plan_name').eq('id', employee.company_id).single();
            if (companyForCompare?.plan_name !== 'Premium') {
              createdAction = { id: null, type: 'compare_documents', title: 'Bu funksiya Premium plan tЙ™lЙ™b edir', detail: 'SЙ™nЙ™d mГјqayisЙ™si, yalnД±z Premium planlД± ЕџirkЙ™tlЙ™r ГјГ§ГјndГјr.', priority: 'normal', status: 'failed' };
            } else {
              const findDoc = async (titleGuess) => {
                const { data } = await supabase.from('documents').select('id, title').eq('company_id', employee.company_id).ilike('title', `%${titleGuess}%`).limit(1).maybeSingle();
                return data;
              };
              const doc1 = await findDoc(actionData.doc1Title);
              const doc2 = await findDoc(actionData.doc2Title);

              if (!doc1 || !doc2) {
                createdAction = { id: null, type: 'compare_documents', title: 'SЙ™nЙ™dlЙ™r tapД±lmadД±', detail: `"${actionData.doc1Title}" vЙ™ ya "${actionData.doc2Title}" tapД±lmadД±`, priority: 'normal', status: 'failed' };
              } else {
                const getContent = async (docId) => {
                  const { data } = await supabase.from('document_chunks').select('content').eq('document_id', docId).order('id', { ascending: true });
                  return (data || []).map(c => c.content).join('\n\n');
                };
                const content1 = await getContent(doc1.id);
                const content2 = await getContent(doc2.id);

                const compareMsg = await anthropic.messages.create({
                  model: 'claude-sonnet-4-6',
                  max_tokens: 800,
                  messages: [{ role: 'user', content: `Bu iki sЙ™nЙ™di mГјqayisЙ™ et, Й™sas fЙ™rqlЙ™ri, risklЙ™ri (varsa) qД±sa, aydД±n maddЙ™lЙ™r halД±nda AzЙ™rbaycan dilindЙ™ yaz.\n\nSЙ™nЙ™d 1 (${doc1.title}):\n${content1}\n\nSЙ™nЙ™d 2 (${doc2.title}):\n${content2}` }]
                });
                const comparisonText = compareMsg.content.map(b => b.text || '').join('');
                createdAction = { id: null, type: 'compare_documents', title: `MГјqayisЙ™: ${doc1.title} vs ${doc2.title}`, detail: comparisonText, priority: 'normal', status: 'completed' };
              }
            }
          } else if (actionData.type === 'send_message') {
            // Kollegaya VUSERA vasitЙ™silЙ™ mesaj Г¶tГјrmЙ™ вЂ” hЙ™qiqi chat yox, bildiriЕџ kimi Г§atdД±rД±lД±r
            const { data: recipient } = await supabase
              .from('employees')
              .select('id, name')
              .eq('company_id', employee.company_id)
              .ilike('name', `%${actionData.recipientName}%`)
              .limit(1)
              .maybeSingle();

            if (recipient) {
              await createNotification(employee.company_id, recipient.id,
                `рџ’¬ ${employee.name}-dan: ${actionData.message}`, null);
              createdAction = { id: null, type: 'send_message', title: `Mesaj gГ¶ndЙ™rildi: ${recipient.name}`, detail: actionData.message, priority: 'normal', status: 'completed' };
            } else {
              createdAction = { id: null, type: 'send_message', title: 'Mesaj gГ¶ndЙ™rilmЙ™di', detail: `"${actionData.recipientName}" adlД± iЕџГ§i tapД±lmadД±`, priority: 'normal', status: 'failed' };
            }
          } else if (actionData.type === 'generate_report') {
            // Hesabat yaratma - format="sheets" olarsa Google Sheets-Й™, Й™ks halda PDF-Й™ yaradД±lД±r
            if (actionData.format === 'sheets') {
              // Eyni sorДџu ilЙ™ real mЙ™lumatД± Г§Й™k, Sheets formatД±na (rows) Г§evir
              let query = supabase
                .from('action_requests')
                .select('*, employees!employee_id(name, role)')
                .eq('company_id', employee.company_id)
                .order('created_at', { ascending: false });
              if (actionData.reportType) query = query.eq('type', actionData.reportType);
              if (actionData.reportStatus) query = query.eq('status', actionData.reportStatus);
              if (actionData.sinceDays) {
                const since = new Date(Date.now() - actionData.sinceDays * 24 * 60 * 60 * 1000).toISOString();
                query = query.gte('created_at', since);
              }
              const { data: sheetRows } = await query;

              const header = { values: ['BaЕџlД±q', 'NГ¶v', 'Status', 'Д°ЕџГ§i', 'Tarix', 'Detal'] };
              const dataRows = (sheetRows || []).map(r => ({
                values: [r.title, r.type, r.status, r.employees?.name || '-', new Date(r.created_at).toLocaleDateString('az-AZ'), r.detail || '']
              }));
              const sheetsResult = await exportToSheetsDirectGoogle(employee.company_id, actionData.title, [header, ...dataRows]);
              createdAction = {
                id: 'sheets-' + Date.now(),
                type: 'generate_report',
                title: sheetsResult.success ? actionData.title : 'Sheets yaradД±lmadД±',
                detail: sheetsResult.success ? `${dataRows.length} qeyd Google Sheets-Й™ ixrac edildi` : '',
                status: sheetsResult.success ? 'created' : 'failed',
                fileUrl: sheetsResult.spreadsheetUrl || null
              };
            } else {
              // Real PDF yaradД±lД±r, "documents" bucket-inЙ™ yГјklЙ™nir
              const reportResult = await generateReportPdf(employee.company_id, actionData.title, {
                type: actionData.reportType || null,
                status: actionData.reportStatus || null,
                sinceDays: actionData.sinceDays || 30
              });
              createdAction = {
                id: 'report-' + Date.now(),
                type: 'generate_report',
                title: reportResult.success ? actionData.title : 'Hesabat yaradД±lmadД±',
                detail: reportResult.success ? `${reportResult.rowCount} qeyd daxildir` : (reportResult.error || ''),
                status: reportResult.success ? 'created' : 'failed',
                fileUrl: reportResult.url || null
              };
            }
          } else {
          // Real Й™mЙ™liyyat sorДџusunu verilЙ™nlЙ™r bazasД±na yaz (status: pending, manager tЙ™sdiqini gГ¶zlЙ™yir)
          // 2000 AZN-dЙ™n yuxarД± xЙ™rc sorДџularД± вЂ” Expense Policy-yЙ™ Й™sasЙ™n 2 tЙ™sdiq (Manager + Finance) tЙ™lЙ™b edir
          let amountValue = actionData.amount ? parseFloat(actionData.amount) : null;
          // DOДћRULAMA: mЙ™nfi vЙ™ ya etibarsД±z (NaN) mЙ™blЙ™Дџi rЙ™dd et (analitika/anomaliya hesablamalarД±nД± qorumaq ГјГ§Гјn)
          if (amountValue !== null && (isNaN(amountValue) || amountValue < 0)) {
            amountValue = null;
          }
          const requiredApprovals = (actionData.type === 'expense_request' && amountValue && amountValue > 2000) ? 2 : 1;

          // PREMIUM: bu ЕџirkЙ™t Premium plandadД±rsa, detallД± task state-i dЙ™ izlЙ™yirik
          let detailedStateFields = {};
          const { data: planCheck } = await supabase.from('companies').select('plan_name').eq('id', employee.company_id).single();
          if (planCheck?.plan_name === 'Premium') {
            detailedStateFields = { detailed_state: 'WAITING_APPROVAL', retry_count: 0 };
          }

          // PREMIUM: MaliyyЙ™ Anomaliya AЕџkarlanmasД± вЂ” bu iЕџГ§inin orta xЙ™rcindЙ™n qeyri-adi yГјksЙ™k mЙ™blЙ™Дџ
          let anomalyNote = '';
          if (planCheck?.plan_name === 'Premium' && actionData.type === 'expense_request' && amountValue) {
            const { data: pastExpenses } = await supabase
              .from('action_requests')
              .select('amount')
              .eq('employee_id', employee.id)
              .eq('type', 'expense_request')
              .not('amount', 'is', null)
              .limit(20);
            if (pastExpenses && pastExpenses.length >= 3) {
              const avg = pastExpenses.reduce((s, e) => s + parseFloat(e.amount), 0) / pastExpenses.length;
              if (amountValue > avg * 3) {
                anomalyNote = ` вљ пёЏ ANOMALД°YA: bu mЙ™blЙ™Дџ (${amountValue} AZN), ${employee.name}-in orta xЙ™rcindЙ™n (${avg.toFixed(0)} AZN) 3 dЙ™fЙ™dЙ™n Г§oxdur.`;
              }
            }
          }

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
              status: 'pending',
              ...detailedStateFields
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

            // BildiriЕџ kimЙ™ getmЙ™lidir? ЖЏmЙ™liyyatД±n nГ¶vГјnЙ™ gГ¶rЙ™ dГјzgГјn departamentЙ™ yГ¶nlЙ™ndiririk:
            // leave_request -> HR, it_ticket -> IT, expense_request -> Finance (kim yaratsa da fЙ™rq etmЙ™z)
            // Admin hЙ™miЕџЙ™ bildiriЕџ alД±r.
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
                `${employee.name} yeni bir ${actionData.type} yaratdД±: "${actionData.title}"${anomalyNote}`, savedAction.id);
            }
          }
          } // send_email deyilsЙ™ bloku baДџlanД±r
          } // idempotency: duplikat deyilsЙ™ bloku baДџlanД±r

          // Г‡OX-ADDIMLI TAPЕћIRIQ: Й™sas Й™mЙ™liyyatdan sonra, istЙ™yЙ™ baДџlД± Й™lavЙ™ email addД±mД±
          if (actionData.notifyEmail && createdAction && createdAction.status !== 'failed' && createdAction.status !== 'duplicate_prevented') {
            const { data: notifyMatch } = await supabase
              .from('employees')
              .select('id')
              .eq('company_id', employee.company_id)
              .eq('email', actionData.notifyEmail)
              .maybeSingle();
            if (notifyMatch) {
              await sendEmailViaMake(employee.company_id, actionData.notifyEmail, `Yeni bildiriЕџ: ${createdAction.title}`, actionData.notifyNote || createdAction.detail || '');
              createdAction.detail = (createdAction.detail || '') + ` В· ${actionData.notifyEmail}-Й™ dЙ™ bildirildi`;
            }
          }

          // Г‡OX-ADDIMLI TAPЕћIRIQ: Й™sas Й™mЙ™liyyatdan sonra, istЙ™yЙ™ baДџlД± Й™lavЙ™ Slack addД±mД±
          // EtibarlД±lД±q ГјГ§Гјn, Claude-un ACTION-a Й™lavЙ™ etmЙ™sinЙ™ gГјvЙ™nmЙ™klЙ™ yanaЕџД±,
          // SГ–HBЖЏT TARД°XГ‡ЖЏSД°NDЖЏN (cari mesaj + Й™vvЙ™lki suallar) dЙ™ birbaЕџa kanal adД±nД± axtarД±rД±q
          // YALNIZ bilavasitЙ™ Й™vvЙ™lki 1 mesaja (bu konkret tЙ™klif-tЙ™sdiq cГјtГјnЙ™) baxД±rД±q,
          // bГјtГјn tarixГ§Й™yЙ™ yox вЂ” kГ¶hnЙ™, Й™laqЙ™siz Slack sorДџularД±nД±n sЙ™hvЙ™n tЙ™krarlanmasД±nД±n qarЕџД±sД±nД± almaq ГјГ§Гјn
          const immediatelyPriorQuestion = (history && history.length > 0) ? history[history.length - 1].question : '';
          const fullConversationText = question + ' ' + immediatelyPriorQuestion;
          const slackChannelFromQuestion = fullConversationText.match(/#([\wЖЏЙ™Г‡Г§ЕћЕџДћДџД°Д±Г–Г¶ГњГј-]+)/);
          const wantsSlack = /slack/i.test(fullConversationText);
          const finalSlackChannel = actionData.notifySlackChannel || (wantsSlack && slackChannelFromQuestion ? `#${slackChannelFromQuestion[1]}` : null);

          if (finalSlackChannel && createdAction && createdAction.status !== 'failed' && createdAction.status !== 'duplicate_prevented') {
            const slackResult = await sendSlackMessage(employee.company_id, finalSlackChannel, actionData.notifySlackNote || `${createdAction.title}: ${createdAction.detail || ''}`);
            if (slackResult.success) {
              createdAction.detail = (createdAction.detail || '') + ` В· Slack-Й™ (${finalSlackChannel}) bildirildi`;
            } else {
              console.error('Slack gГ¶ndЙ™rilmЙ™di:', slackResult.error);
            }
          }
        } catch (e) {
          console.error('Action parse xЙ™tasД±:', e.message);
        }
      } else {
        // Adi SOURCE mЙ™nbЙ™sini tЙ™mizlЙ™ (cavabД±n son sЙ™trini saxlayД±rД±q, sadЙ™cЙ™ gГ¶rГјnГјЕџГј tЙ™mizlЙ™yirik)
        const sourceMatch = answerText.match(/SOURCE:\s*(.+)$/m);
        if (sourceMatch && sourceMatch[1].trim() === 'NONE') sourceType = 'not_found';
      }
    }

    // Follow-up tЙ™klifini ayД±r (varsa) вЂ” cavab mЙ™tnindЙ™n Г§Д±xarД±b, ayrД±ca sahЙ™dЙ™ qaytarД±rД±q
    let suggestion = null;
    const suggestionMatch = answerText.match(/SUGGESTION:\s*(.+)$/m);
    if (suggestionMatch) {
      suggestion = suggestionMatch[1].trim();
      answerText = answerText.replace(/SUGGESTION:\s*.+$/m, '').trim();
    }

    // 7) SГ¶hbЙ™ti logla (analitika/dashboard ГјГ§Гјn) вЂ” token istifadЙ™si dЙ™ (yalnД±z VUSERA-nД±n Г¶z maliyyЙ™ izlЙ™mЙ™si ГјГ§Гјn) saxlanД±lД±r
    await supabase.from('chat_logs').insert({
      company_id: employee.company_id,
      employee_id: employee.id,
      question,
      answer: answerText,
      source_type: sourceType,
      input_tokens: message.usage?.input_tokens || 0,
      output_tokens: message.usage?.output_tokens || 0,
      cache_creation_input_tokens: message.usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens: message.usage?.cache_read_input_tokens || 0
    });

    // TЖЏHLГњKЖЏSД°ZLД°K ЕћЖЏBЖЏKЖЏSД°: Й™gЙ™r hЙ™r hansД± sЙ™bЙ™bdЙ™n xam "ACTION:{...}" mЙ™tni cavabda qalД±bsa
    // (mЙ™s. nadir bir parse xЙ™tasД±), bunu istifadЙ™Г§iyЙ™ gГ¶stЙ™rmЙ™dЙ™n tЙ™mizlЙ™yirik
    if (answerText.includes('ACTION:')) {
      answerText = answerText.replace(/ACTION:\s*\{[\s\S]*?\}/g, '').trim();
      if (!answerText) answerText = 'SorДџunuz emal edildi.';
    }

    // Real etibarlilq balД± вЂ” RAG uygunlugunun en yuksek deyeri (varsa)
    const topSimilarity = allowedChunks.length > 0 ? Math.max(...allowedChunks.map(c => c.similarity || 0)) : null;
    let confidenceLevel = null;
    if (topSimilarity !== null) {
      if (topSimilarity >= 0.75) confidenceLevel = 'high';
      else if (topSimilarity >= 0.55) confidenceLevel = 'medium';
      else confidenceLevel = 'low';
    }

    // Istifade edilen senedin REAL metadatasi (varsa) - ilk uygun parcanin sened melumati
    let sourceDocMeta = null;
    if (allowedChunks.length > 0) {
      const { data: docMeta } = await supabase.from('documents').select('title, doc_code').eq('id', allowedChunks[0].document_id).maybeSingle();
      if (docMeta) sourceDocMeta = { title: docMeta.title, docCode: docMeta.doc_code || null };
    }

    // Real is teyini uchun, tamamlanmis emeliyyatin qenaet etdiyi teqribi vaxt (deqiqe)
    if (createdAction && createdAction.status !== 'failed' && createdAction.type) {
      createdAction.timeSavedMinutes = TIME_SAVED_MINUTES[createdAction.type] || 8;
    }

    res.json({ answer: answerText, employee: employee.name, role: employee.role, action: createdAction, suggestion, confidenceLevel, topSimilarity, sourceDocMeta, modelUsed: 'Sonnet' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- SЙ™nЙ™d yГјklЙ™mЙ™: /ingest ----
// Bu, ingest.js skriptinin veb versiyasД±dД±r вЂ” kompГјterdЙ™ heГ§ bir quraЕџdД±rma tЙ™lЙ™b etmir.
// Д°ki Гјsulla mЙ™zmun qЙ™bul edir:
//   1) "content" вЂ” sadЙ™ mЙ™tn (Й™vvЙ™lki kimi)
//   2) "fileBase64" + "fileType" ('pdf' vЙ™ ya 'docx') вЂ” real fayldan mЙ™tn Г§Д±xarД±r
// ---- QЙ™bz/Faktura oxuma вЂ” real ЕџЙ™kil/PDF-dЙ™n xЙ™rc mЙ™lumatД±nД± Г§Д±xarД±r ----
// Email paneli ГјГ§Гјn вЂ” birbaЕџa inbox-u gЙ™tirir (chat axД±nД±ndan kЙ™nar)
app.get('/emails', requireAuth, async (req, res) => {
  try {
    const emails = await readRecentEmails(req.employee.company_id);
    res.json({ emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GЙ™lЙ™n emaillЙ™ri AI ilЙ™ kateqoriyalara ayД±rД±r вЂ” cavab tЙ™lЙ™b edЙ™nlЙ™ri vЙ™ follow-up-larД± tez tapmaq ГјГ§Гјn.
app.post('/emails/analyze', requireAuth, async (req, res) => {
  try {
    const emails = Array.isArray(req.body?.emails) ? req.body.emails.slice(0, 30) : await readRecentEmails(req.employee.company_id);
    if (!emails.length) return res.json({ analyses: [] });
    const compact = emails.map((e, i) => ({ index:i, from:e.fromName || e.fromEmail || '', subject:e.subject || '', snippet:(e.snippet || '').slice(0, 700) }));
    const prompt = `Bu email siyahД±sД±nД± AzЙ™rbaycan dilindЙ™ analiz et. HЙ™r email ГјГ§Гјn yalnД±z JSON qaytar: [{"index":0,"category":"positive|negative|interested|later|reply_required|newsletter|automatic|information","needsReply":true,"priority":"high|medium|low","reason":"qД±sa sЙ™bЙ™b","nextStep":"qД±sa nГ¶vbЙ™ti addД±m"}]. HeГ§ bir markdown vЙ™ Й™lavЙ™ mЙ™tn yazma.\n\n${JSON.stringify(compact)}`;
    const message = await anthropic.messages.create({ model:'claude-sonnet-4-6', max_tokens:1800, system:'SЙ™n ЕџirkЙ™t email triage kГ¶mЙ™kГ§isisЙ™n. YalnД±z valid JSON qaytar.', messages:[{role:'user',content:prompt}] });
    const raw = message.content.map(b=>b.text||'').join('').replace(/^```json\s*|\s*```$/g,'').trim();
    let analyses; try { analyses = JSON.parse(raw); } catch { return res.status(502).json({ error:'Email analizi JSON formatД±nda qaytarД±lmadД±' }); }
    res.json({ analyses: Array.isArray(analyses) ? analyses : [] });
  } catch (err) { console.error('Email analiz xЙ™tasД±:', err.message); res.status(500).json({ error:'Email analizi hazД±rda mГјmkГјn deyil' }); }
});

// Email paneli ГјГ§Гјn вЂ” birbaЕџa email gГ¶ndЙ™rir (chat axД±nД±ndan kЙ™nar, sadЙ™ forma ГјГ§Гјn)
app.post('/emails/send', requireAuth, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject vЙ™ body tЙ™lЙ™b olunur' });

    // TЖЏHLГњKЖЏSД°ZLД°K: "to" ГјnvanД± YA daxili iЕџГ§i direktoriyasД±nda, YA DA
    // yaxД±nlarda DAXД°L OLAN bir email-in gГ¶ndЙ™rЙ™ni olmalД±dД±r (bu, xarici insanlara вЂ”
    // mЙ™s. mГјЕџtЙ™rilЙ™rЙ™, tЙ™lЙ™bЙ™lЙ™rЙ™ вЂ” CAVAB yazmaДџa imkan verir, amma tam uydurma Гјnvana
    // gГ¶ndЙ™rmЙ™yin qarЕџД±sД±nД± alД±r, Г§Гјnki hЙ™min Гјnvan artД±q REAL olaraq bizЙ™ yazД±b)
    const { data: employeeMatch } = await supabase
      .from('employees')
      .select('id')
      .eq('company_id', req.employee.company_id)
      .eq('email', to)
      .maybeSingle();

    let isVerified = !!employeeMatch;
    if (!isVerified) {
      try {
        const recentEmails = await readRecentEmailsDirect(req.employee.company_id);
        isVerified = recentEmails.some(e => (e.fromEmail || '').toLowerCase() === to.toLowerCase());
      } catch (e) { /* Gmail oxuna bilmirse, sadece iscilerle mehdudlashir */ }
    }
    if (!isVerified) return res.status(400).json({ error: 'Bu email ГјnvanД± nЙ™ ЕџirkЙ™t direktoriyasД±nda, nЙ™ dЙ™ son daxil olan emaillЙ™rdЙ™ tapД±lmadД±' });

    const result = await sendEmailViaMake(req.employee.company_id, to, subject, body);
    res.json({ success: result.success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/receipts/extract', requireAuth, async (req, res) => {
  try {
    const { fileBase64, fileType } = req.body;
    if (!fileBase64 || !fileType) {
      return res.status(400).json({ error: 'fileBase64 vЙ™ fileType tЙ™lЙ™b olunur' });
    }

    const mediaType = fileType === 'pdf' ? 'application/pdf'
      : fileType === 'jpg' || fileType === 'jpeg' ? 'image/jpeg'
      : fileType === 'png' ? 'image/png'
      : null;
    if (!mediaType) return res.status(400).json({ error: 'fileType "pdf", "jpg", "jpeg" vЙ™ ya "png" olmalД±dД±r' });

    const contentBlockType = fileType === 'pdf' ? 'document' : 'image';

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: [
          { type: contentBlockType, source: { type: 'base64', media_type: mediaType, data: fileBase64 } },
          { type: 'text', text: `Bu sЙ™nЙ™d ya sadЙ™ bir QЖЏBZ (kassa Г§eki), ya da rЙ™smi bir FAKTURA (invoice)-dur. ЖЏvvЙ™lcЙ™ hansД± olduДџunu mГјЙ™yyЙ™n et, sonra uyДџun JSON formatД±nda, YALNIZ JSON qaytar (baЕџqa mЙ™tn yazma):

ЖЏgЙ™r sadЙ™ QЖЏBZ-dirsЙ™: {"documentType":"receipt","vendor":"satД±cД± adД±","amount":rЙ™qЙ™m,"currency":"AZN/USD/EUR","date":"YYYY-MM-DD","category":"travel|meals|office|other","description":"qД±sa tЙ™svir"}

ЖЏgЙ™r rЙ™smi FAKTURA-dД±rsa (invoice number, VГ–EN/tax ID, line items olan): {"documentType":"invoice","vendor":"satД±cД± ЕџirkЙ™t adД±","vendorTaxId":"VГ–EN/tax ID vЙ™ ya null","invoiceNumber":"faktura nГ¶mrЙ™si","invoiceDate":"YYYY-MM-DD","dueDate":"YYYY-MM-DD vЙ™ ya null","amount":Гјmumi_meblegh_reqem,"currency":"AZN/USD/EUR","lineItems":[{"description":"xidmet/mehsul adД±","quantity":reqem,"unitPrice":reqem,"total":reqem}],"category":"travel|meals|office|other"}

ЖЏgЙ™r bir sahЙ™ni tapa bilmirsЙ™nsЙ™, null yaz.` }
        ]
      }]
    });

    const rawText = message.content.map(b => b.text || '').join('');
    const jsonMatch = rawText.match(/\{.*\}/s);
    if (!jsonMatch) return res.status(422).json({ error: 'SЙ™nЙ™ddЙ™n mЙ™lumat Г§Д±xarД±la bilmЙ™di' });

    const extracted = JSON.parse(jsonMatch[0]);
    res.json({ success: true, extracted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/ingest', ingestLimiter, requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin sЙ™nЙ™d yГјklЙ™yЙ™ bilЙ™r' });

    const { companyId, title, docCode, content, fileBase64, fileType, restrictedRoles, isTemplate } = req.body;
    if (!companyId || !title) {
      return res.status(400).json({ error: 'companyId vЙ™ title tЙ™lЙ™b olunur' });
    }
    if (companyId !== req.employee.company_id) {
      return res.status(403).json({ error: 'YalnД±z Г¶z ЕџirkЙ™tiniz ГјГ§Гјn sЙ™nЙ™d yГјklЙ™yЙ™ bilЙ™rsiniz' });
    }
    if (!content && !fileBase64) {
      return res.status(400).json({ error: 'content vЙ™ ya fileBase64 tЙ™lЙ™b olunur' });
    }

    let extractedText = content;
    let fileUrl = null;

    // ЖЏgЙ™r real fayl gГ¶ndЙ™rilibsЙ™, ondan mЙ™tni Г§Д±xarД±rД±q VЖЏ faylД±n Г¶zГјnГј dЙ™ saxlayД±rД±q (aГ§Д±la bilsin deyЙ™)
    if (fileBase64) {
      const buffer = Buffer.from(fileBase64, 'base64');

      if (fileType === 'pdf') {
        const parsed = await pdfParse(buffer);
        extractedText = parsed.text;
      } else if (fileType === 'docx') {
        const parsed = await mammoth.extractRawText({ buffer });
        extractedText = parsed.value;
      } else {
        return res.status(400).json({ error: 'fileType "pdf" vЙ™ ya "docx" olmalД±dД±r' });
      }

      // FaylД±n Г¶zГјnГј Supabase Storage-a yГјklЙ™yirik ki, sonradan "aГ§" dГјymЙ™si iЕџlЙ™sin
      const fileName = `${companyId}/${Date.now()}-${title.replace(/[^a-zA-Z0-9._-]/g, '_')}.${fileType}`;
      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(fileName, buffer, {
          contentType: fileType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });

      if (uploadError) {
        console.error('Fayl saxlanma xЙ™tasД± (mЙ™tn yenЙ™ dЙ™ indekslЙ™nЙ™cЙ™k):', uploadError.message);
      } else {
        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
        fileUrl = urlData?.publicUrl || null;
      }
    }

    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ error: 'SЙ™nЙ™ddЙ™n mЙ™tn Г§Д±xarД±la bilmЙ™di (boЕџ fayl ola bilЙ™r)' });
    }

    const restricted = Array.isArray(restrictedRoles) ? restrictedRoles : [];

    const { data: doc, error: docError } = await supabase
      .from('documents')
      .insert({ company_id: companyId, title, doc_code: docCode || null, restricted_to_roles: restricted, file_url: fileUrl, is_template: !!isTemplate })
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

    // Document-to-Workflow: baЕџlД±qda "URGENT" / "TЖЏCД°LД°" varsa, avtomatik bГјtГјn manager/admin-lЙ™rЙ™ bildir
    if (/urgent|tЙ™cili|acil/i.test(title)) {
      const { data: allStaff } = await supabase.from('employees').select('id, role').eq('company_id', companyId);
      (allStaff || []).filter(m => m.role === 'Admin' || m.role.includes('Manager'))
        .forEach(m => createNotification(companyId, m.id, `рџљЁ TЙ™cili sЙ™nЙ™d yГјklЙ™ndi: "${title}" вЂ” nЙ™zЙ™rdЙ™n keГ§irin.`, null));
    }

    res.json({ success: true, documentId: doc.id, chunksCreated: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Demo kГ¶mЙ™kГ§i endpoint-lЙ™r ----

app.get('/employees', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('employees')
    .select('*, departments(name)')
    .eq('company_id', req.employee.company_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Yeni iЕџГ§i Й™lavЙ™ etmЙ™k (gЙ™lЙ™cЙ™k Admin panel ГјГ§Гјn Й™sas) вЂ” AVTOMATIK giriЕџ hesabД± da yaradД±lД±r
app.post('/employees', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin yeni iЕџГ§i Й™lavЙ™ edЙ™ bilЙ™r' });

    const { companyId, departmentId, name, email, role } = req.body;
    if (!companyId || !name || !role || !email) {
      return res.status(400).json({ error: 'companyId, name, email vЙ™ role tЙ™lЙ™b olunur' });
    }
    if (companyId !== req.employee.company_id) {
      return res.status(403).json({ error: 'YalnД±z Г¶z ЕџirkЙ™tiniz ГјГ§Гјn iЕџГ§i Й™lavЙ™ edЙ™ bilЙ™rsiniz' });
    }

    // MГјvЙ™qqЙ™ti parol yaradД±rД±q вЂ” iЕџГ§i ilk giriЕџdЙ™n sonra "Parolu unutmuЕџam" ilЙ™ Г¶z parolunu tЙ™yin edЙ™ bilЙ™r
    const tempPassword = 'Vusera' + Math.random().toString(36).slice(-8) + '!';

    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email, password: tempPassword, email_confirm: true
    });
    if (authError) return res.status(400).json({ error: 'GiriЕџ hesabД± yaradД±la bilmЙ™di: ' + authError.message });

    const { data, error } = await supabase
      .from('employees')
      .insert({ company_id: companyId, department_id: departmentId || null, name, email, role, auth_user_id: authUser.user.id })
      .select()
      .single();
    if (error) throw error;

    // ---- ONBOARDING WORKFLOW вЂ” avtomatik addД±mlar ----
    // 1) Yeni iЕџГ§iyЙ™ xoЕџ gЙ™ldin email-i (giriЕџ mЙ™lumatlarД± ilЙ™)
    sendEmailViaMake(
      companyId,
      email,
      `VUSERA-ya xoЕџ gЙ™ldiniz, ${name}!`,
      `Salam ${name},\n\nNovaTech Solutions-a xoЕџ gЙ™ldiniz! VUSERA Employee Copilot hesabД±nД±z hazД±rdД±r.\n\nGiriЕџ mЙ™lumatlarД±nД±z:\nEmail: ${email}\nMГјvЙ™qqЙ™ti parol: ${tempPassword}\n\nД°lk giriЕџdЙ™n sonra parolunuzu dЙ™yiЕџmЙ™yiniz tГ¶vsiyЙ™ olunur.\n\nUДџurlar!\nVUSERA`
    );

    // 2) IT departamentinЙ™ bildiriЕџ (avadanlД±q/giriЕџ hazД±rlД±ДџД± ГјГ§Гјn)
    const { data: itManagers } = await supabase
      .from('employees')
      .select('id, role, departments(name)')
      .eq('company_id', companyId);
    (itManagers || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'IT'))
      .forEach(m => createNotification(companyId, m.id, `рџ‘‹ Yeni iЕџГ§i: ${name} (${role}) baЕџladД± вЂ” noutbuk/giriЕџ hazД±rlД±ДџД± lazД±mdД±r.`, null));

    // 3) HR departamentinЙ™ bildiriЕџ (sЙ™nЙ™dlЙ™ЕџmЙ™ ГјГ§Гјn)
    (itManagers || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'HR'))
      .forEach(m => createNotification(companyId, m.id, `рџ‘‹ Yeni iЕџГ§i qeydЙ™ alД±ndД±: ${name} (${role}) вЂ” HR sЙ™nЙ™dlЙ™ЕџmЙ™si lazД±mdД±r.`, null));

    res.json({ success: true, employee: data, temporaryPassword: tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Д°ЕџГ§i mЙ™lumatД±nД± dЙ™yiЕџmЙ™k (ad, rol, departament)
app.put('/employees/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin iЕџГ§i mЙ™lumatД±nД± dЙ™yiЕџЙ™ bilЙ™r' });

    const { data: targetEmp } = await supabase.from('employees').select('company_id').eq('id', req.params.id).single();
    if (!targetEmp) return res.status(404).json({ error: 'Д°ЕџГ§i tapД±lmadД±' });
    if (targetEmp.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu iЕџГ§i sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

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

// Д°ЕџГ§ini deaktiv etmЙ™k (silmЙ™k Й™vЙ™zinЙ™ вЂ” tarixГ§Й™ni qorumaq ГјГ§Гјn status dЙ™yiЕџdiririk)
app.delete('/employees/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin iЕџГ§ini deaktiv edЙ™ bilЙ™r' });

    const { data: targetEmp } = await supabase.from('employees').select('company_id').eq('id', req.params.id).single();
    if (!targetEmp) return res.status(404).json({ error: 'Д°ЕџГ§i tapД±lmadД±' });
    if (targetEmp.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu iЕџГ§i sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    const { data, error } = await supabase
      .from('employees')
      .update({ status: 'inactive' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    // ---- OFFBOARDING WORKFLOW вЂ” avtomatik addД±mlar ----
    // 1) BГјtГјn gЙ™lЙ™cЙ™k aktiv gГ¶rГјЕџlЙ™rini lЙ™Дџv et
    const { data: activeMeetings } = await supabase
      .from('meetings')
      .select('*')
      .eq('employee_id', data.id)
      .eq('status', 'active');
    for (const m of (activeMeetings || [])) {
      if (m.calendar_event_id) {
        const cancelResult = await cancelMeetingDirectGoogle(data.company_id, m.calendar_event_id);
        if (cancelResult.success) {
          await supabase.from('meetings').update({ status: 'cancelled' }).eq('id', m.id);
        }
      }
    }

    // 2) IT departamentinЙ™ bildiriЕџ (avadanlД±q geri qaytarД±lmasД±, giriЕџ baДџlanmasД± ГјГ§Гјn)
    const { data: allStaff } = await supabase
      .from('employees')
      .select('id, role, departments(name)')
      .eq('company_id', data.company_id);
    (allStaff || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'IT'))
      .forEach(m => createNotification(data.company_id, m.id, `рџ‘‹ ${data.name} iЕџdЙ™n ayrД±lД±r вЂ” avadanlД±q geri qaytarД±lmalД±, giriЕџ baДџlanmalД±dД±r.`, null));

    // 3) HR departamentinЙ™ bildiriЕџ (son sЙ™nЙ™dlЙ™ЕџmЙ™ ГјГ§Гјn)
    (allStaff || []).filter(m => m.role === 'Admin' || (m.role.includes('Manager') && m.departments?.name === 'HR'))
      .forEach(m => createNotification(data.company_id, m.id, `рџ‘‹ ${data.name} iЕџdЙ™n ayrД±lД±r вЂ” son hesablaЕџma/sЙ™nЙ™dlЙ™ЕџmЙ™ lazД±mdД±r.`, null));

    // 4) GГ¶zlЙ™yЙ™n (pending) sorДџularД± yoxla вЂ” Admin-Й™ xЙ™bЙ™rdarlД±q et ki, unudulmasД±n
    const { data: pendingReqs } = await supabase
      .from('action_requests')
      .select('id, type, title')
      .eq('employee_id', data.id)
      .eq('status', 'pending');
    if (pendingReqs && pendingReqs.length > 0) {
      (allStaff || []).filter(m => m.role === 'Admin')
        .forEach(m => createNotification(data.company_id, m.id,
          `вљ пёЏ ${data.name} iЕџdЙ™n ayrД±lД±r, amma ${pendingReqs.length} gГ¶zlЙ™yЙ™n sorДџusu var (hЙ™ll edilmЙ™miЕџ) вЂ” nЙ™zЙ™rdЙ™n keГ§irin.`, null));
    }

    res.json({ success: true, employee: data, meetingsCancelled: (activeMeetings || []).length, pendingRequestsFlagged: (pendingReqs || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Yeni ЕџirkЙ™t (workspace) yaratmaq вЂ” hЙ™r mГјЕџtЙ™ri ГјГ§Гјn ayrД±ca mГјhit
// ---- YENД° ЕћД°RKЖЏT ONBOARDING вЂ” bir Г§aДџД±rД±Еџla: ЕџirkЙ™t + standart departamentlЙ™r + Admin hesabД± ----
// Bu, yalnД±z VUSERA-nД±n Г¶z komandasД± (API_SECRET bilЙ™n) tЙ™rЙ™findЙ™n Г§aДџД±rД±lmalД±dД±r вЂ” yeni mГјЕџtЙ™ri Й™lavЙ™ etmЙ™k ГјГ§Гјn.
app.post('/onboarding/new-company', async (req, res) => {
  const ownerProvided = req.headers['x-owner-secret'];
  if (!process.env.OWNER_SECRET || ownerProvided !== process.env.OWNER_SECRET) {
    return res.status(403).json({ error: 'Д°cazЙ™ yoxdur' });
  }
  try {
    const { companyName, adminName, adminEmail } = req.body;
    if (!companyName || !adminName || !adminEmail) {
      return res.status(400).json({ error: 'companyName, adminName vЙ™ adminEmail tЙ™lЙ™b olunur' });
    }

    // 1) ЕћirkЙ™ti yarat
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .insert({ name: companyName })
      .select()
      .single();
    if (companyError) throw companyError;

    // 2) Standart 5 departamenti yarat (HR, IT, Finance, Sales, Operations)
    const deptNames = ['HR', 'IT', 'Finance', 'Sales', 'Operations'];
    const { data: depts, error: deptError } = await supabase
      .from('departments')
      .insert(deptNames.map(name => ({ company_id: company.id, name })))
      .select();
    if (deptError) throw deptError;
    const adminDept = depts.find(d => d.name === 'Operations') || depts[0];

    // 3) Admin ГјГ§Гјn Supabase Auth hesabД± yarat (mГјvЙ™qqЙ™ti parolla)
    const temporaryPassword = 'Vusera' + Math.random().toString(36).slice(-8) + '!';
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email: adminEmail,
      password: temporaryPassword,
      email_confirm: true
    });
    if (authError) throw authError;

    // 4) Admin iЕџГ§i qeydini yarat, auth hesabД± ilЙ™ baДџla
    const { data: adminEmp, error: empError } = await supabase
      .from('employees')
      .insert({
        company_id: company.id,
        department_id: adminDept.id,
        name: adminName,
        email: adminEmail,
        role: 'Admin',
        auth_user_id: authUser.user.id,
        status: 'active'
      })
      .select()
      .single();
    if (empError) throw empError;

    res.json({
      success: true,
      company: { id: company.id, name: company.name },
      departments: depts.map(d => ({ id: d.id, name: d.name })),
      admin: { name: adminName, email: adminEmail, temporaryPassword }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/companies', async (req, res) => {
  const provided = req.headers['x-owner-secret'];
  if (!process.env.OWNER_SECRET || provided !== process.env.OWNER_SECRET) {
    return res.status(403).json({ error: 'Д°cazЙ™ yoxdur' });
  }
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name tЙ™lЙ™b olunur' });
    const { data, error } = await supabase.from('companies').insert({ name }).select().single();
    if (error) throw error;
    res.json({ success: true, company: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ЕћirkЙ™t ГјГ§Гјn departament yaratmaq
app.post('/departments', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin departament yarada bilЙ™r' });
    const { companyId, name } = req.body;
    if (!companyId || !name) return res.status(400).json({ error: 'companyId vЙ™ name tЙ™lЙ™b olunur' });
    if (companyId !== req.employee.company_id) {
      return res.status(403).json({ error: 'YalnД±z Г¶z ЕџirkЙ™tiniz ГјГ§Гјn departament yarada bilЙ™rsiniz' });
    }
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

// ЕћirkЙ™tin departamentlЙ™rini siyahД± kimi gЙ™tirmЙ™k (admin panel ГјГ§Гјn)
app.get('/departments/:companyId', requireAuth, async (req, res) => {
  if (req.employee.company_id !== req.params.companyId) {
    return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
  }
  const { data, error } = await supabase
    .from('departments')
    .select('id, name')
    .eq('company_id', req.params.companyId)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ЕћirkЙ™t sЙ™nЙ™dlЙ™ri
app.get('/documents/:companyId', requireAuth, async (req, res) => {
  if (req.employee.company_id !== req.params.companyId) {
    return res.status(403).json({ error: 'Bu ЕџirkЙ™tin sЙ™nЙ™dlЙ™rinЙ™ giriЕџiniz yoxdur' });
  }
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, doc_code, restricted_to_roles, uploaded_at, file_url')
    .eq('company_id', req.params.companyId)
    .order('uploaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// SЙ™nЙ™d mЙ™lumatД±nД± yenilЙ™mЙ™k (ad, kod, icazЙ™lЙ™r вЂ” mЙ™zmunu dЙ™yiЕџmЙ™k ГјГ§Гјn silib yenidЙ™n yГјklЙ™yin)
app.put('/documents/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin sЙ™nЙ™di dЙ™yiЕџЙ™ bilЙ™r' });

    const { data: targetDoc } = await supabase.from('documents').select('company_id').eq('id', req.params.id).single();
    if (!targetDoc) return res.status(404).json({ error: 'SЙ™nЙ™d tapД±lmadД±' });
    if (targetDoc.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu sЙ™nЙ™d sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

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

// SЙ™nЙ™din MЖЏTNД°NД° (mЙ™zmununu) redaktЙ™ etmЙ™k вЂ” kГ¶hnЙ™ parГ§alarД± silib, yenisini yenidЙ™n chunk+embed edir
app.put('/documents/:id/content', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin sЙ™nЙ™di dЙ™yiЕџЙ™ bilЙ™r' });

    const { data: targetDoc } = await supabase.from('documents').select('company_id').eq('id', req.params.id).single();
    if (!targetDoc) return res.status(404).json({ error: 'SЙ™nЙ™d tapД±lmadД±' });
    if (targetDoc.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu sЙ™nЙ™d sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content tЙ™lЙ™b olunur' });

    // 1) KГ¶hnЙ™ parГ§alarД± sil
    await supabase.from('document_chunks').delete().eq('document_id', req.params.id);

    // 2) Yeni mЙ™zmunu chunk-la, hЙ™r parГ§anД± embed edib yenidЙ™n yaz
    const chunks = chunkDocument(content);
    for (const chunk of chunks) {
      const embedding = await getEmbedding(chunk.content);
      const { error: chunkError } = await supabase
        .from('document_chunks')
        .insert({ document_id: req.params.id, section_label: chunk.section_label, content: chunk.content, embedding });
      if (chunkError) throw chunkError;
    }

    res.json({ success: true, chunksUpdated: chunks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SЙ™nЙ™din cari tam mЙ™tnini gЙ™tirir (redaktЙ™ pЙ™ncЙ™rЙ™sini doldurmaq ГјГ§Гјn)
app.get('/documents/:id/content', requireAuth, async (req, res) => {
  try {
    const { data: targetDoc } = await supabase.from('documents').select('company_id').eq('id', req.params.id).single();
    if (!targetDoc) return res.status(404).json({ error: 'SЙ™nЙ™d tapД±lmadД±' });
    if (targetDoc.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu sЙ™nЙ™d sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    const { data, error } = await supabase
      .from('document_chunks')
      .select('content')
      .eq('document_id', req.params.id)
      .order('id', { ascending: true });
    if (error) throw error;
    const fullText = (data || []).map(c => c.content).join('\n\n');
    res.json({ content: fullText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ЕћablonlarД±n siyahД±sД± (yalnД±z is_template=true olanlar)
app.get('/documents/:companyId/templates', requireAuth, async (req, res) => {
  try {
    if (req.employee.company_id !== req.params.companyId) {
      return res.status(403).json({ error: 'Bu ЕџirkЙ™tin ЕџablonlarД±na giriЕџiniz yoxdur' });
    }
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, doc_code')
      .eq('company_id', req.params.companyId)
      .eq('is_template', true);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ећablon Й™sasД±nda yeni sЙ™nЙ™d yaradД±r вЂ” {{PLACEHOLDER}} formatД±ndakД± yerlЙ™ri doldurur
app.post('/documents/from-template', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin sЙ™nЙ™d yarada bilЙ™r' });
    const { templateId, newTitle, replacements } = req.body;
    if (!templateId || !newTitle) return res.status(400).json({ error: 'templateId vЙ™ newTitle tЙ™lЙ™b olunur' });

    const { data: templateDoc } = await supabase.from('documents').select('*').eq('id', templateId).single();
    if (!templateDoc) return res.status(404).json({ error: 'Ећablon tapД±lmadД±' });
    if (templateDoc.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu Еџablon sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    const { data: chunks } = await supabase
      .from('document_chunks')
      .select('content')
      .eq('document_id', templateId)
      .order('id', { ascending: true });

    let fullText = (chunks || []).map(c => c.content).join('\n\n');
    for (const [key, value] of Object.entries(replacements || {})) {
      fullText = fullText.replaceAll(`{{${key}}}`, value);
    }

    const { data: newDoc, error: docError } = await supabase
      .from('documents')
      .insert({ company_id: templateDoc.company_id, title: newTitle, restricted_to_roles: templateDoc.restricted_to_roles, is_template: false })
      .select()
      .single();
    if (docError) throw docError;

    const newChunks = chunkDocument(fullText);
    for (const chunk of newChunks) {
      const embedding = await getEmbedding(chunk.content);
      await supabase.from('document_chunks').insert({ document_id: newDoc.id, section_label: chunk.section_label, content: chunk.content, embedding });
    }

    res.json({ success: true, document: newDoc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SЙ™nЙ™di tamamilЙ™ silmЙ™k (bГјtГјn parГ§alarД±/embedding-lЙ™ri dЙ™ silinir вЂ” cascade)
app.delete('/documents/:id', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin sЙ™nЙ™di silЙ™ bilЙ™r' });

    const { data: targetDoc } = await supabase.from('documents').select('company_id').eq('id', req.params.id).single();
    if (!targetDoc) return res.status(404).json({ error: 'SЙ™nЙ™d tapД±lmadД±' });
    if (targetDoc.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu sЙ™nЙ™d sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'SЙ™nЙ™d vЙ™ bГјtГјn parГ§alarД± silindi' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit Log вЂ” kim, nЙ™ vaxt, nЙ™ edib (sГ¶hbЙ™tlЙ™r + Й™mЙ™liyyatlar birlЙ™ЕџdirilmiЕџ xronoloji siyahД±)
app.get('/audit-log/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin audit logu gГ¶rЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
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
        actor: c.employees?.name || 'NamЙ™lum',
        actorRole: c.employees?.role,
        eventType: 'question',
        description: `"${c.question}" вЂ” nЙ™ticЙ™: ${c.source_type}`
      });
    }

    for (const a of actions || []) {
      events.push({
        timestamp: a.created_at,
        actor: a.employees?.name || 'NamЙ™lum',
        actorRole: a.employees?.role,
        eventType: 'action_created',
        description: `${a.type} yaratdД±: "${a.title}" (status: ${a.status})`
      });
      if (a.approved_at) {
        events.push({
          timestamp: a.approved_at,
          actor: a.approver?.name || 'NamЙ™lum',
          eventType: a.status === 'approved' ? 'action_approved' : 'action_rejected',
          description: `"${a.title}" sorДџusunu ${a.status === 'approved' ? 'tЙ™sdiqlЙ™di' : 'rЙ™dd etdi'}`
        });
      }
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(events.slice(0, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persistent task center (tenant-safe: company_id always comes from the authenticated employee)
app.get('/tasks', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('tasks').select('*').eq('company_id', req.employee.company_id).order('due_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/tasks', requireAuth, async (req, res) => {
  const { title, detail, priority = 'B', due_at, assigned_to, status = 'waiting', next_step, source = 'chat' } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'TapЕџД±rД±q adД± tЙ™lЙ™b olunur' });
  const { data, error } = await supabase.from('tasks').insert({ company_id: req.employee.company_id, employee_id: req.employee.id, title: String(title).trim(), detail, priority, due_at: due_at || null, assigned_to: assigned_to || null, status, next_step, source }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/tasks/:id', requireAuth, async (req, res) => {
  const allowed = ['title','detail','priority','due_at','assigned_to','status','next_step'];
  const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const { data, error } = await supabase.from('tasks').update(updates).eq('id', req.params.id).eq('company_id', req.employee.company_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/company-settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('company_settings').select('*').eq('company_id', req.employee.company_id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || {});
});

app.put('/company-settings', requireAuth, async (req, res) => {
  const body = req.body || {};
  const payload = { company_id: req.employee.company_id, sector: body.sector || null, systems: Array.isArray(body.systems) ? body.systems : String(body.systems || '').split(',').map(s => s.trim()).filter(Boolean), approval_rules: body.approval_rules || body.approvals || null, approver_mapping: body.approver_mapping || body.approver || null, writing_tone: body.writing_tone || body.tone || null, preferred_language: body.preferred_language || 'az' };
  const { data, error } = await supabase.from('company_settings').upsert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Д°ЕџГ§inin Г–Z sorДџularД±nД± gГ¶stЙ™rir (URL-dЙ™ki ID-yЙ™ deyil, tЙ™sdiqlЙ™nmiЕџ tokenЙ™ Й™saslanД±r)
app.get('/actions/me', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('action_requests')
    .select('*')
    .eq('employee_id', req.employee.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Manager tЙ™sdiqi: /actions/:id/approve vЙ™ /actions/:id/reject ----

function isManagerRole(role) {
  return role.includes('Manager') || role === 'Admin';
}

// Bu manager, bu konkret sorДџunu tЙ™sdiqlЙ™mЙ™yЙ™/rЙ™ddЙ™ sЙ™lahiyyЙ™tlidirmi? (Admin hЙ™miЕџЙ™ bЙ™li)
// Qayda: leave_request -> HR, it_ticket -> IT, expense_request -> Finance (kim yaratsa da fЙ™rq etmЙ™z)
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

  // Delegation yoxlanД±ЕџД± вЂ” bu ЕџЙ™xsЙ™ mГјvЙ™qqЙ™ti olaraq bu departamentin tЙ™sdiq sЙ™lahiyyЙ™ti verilibmi?
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
    if (actionCheckError || !actionCheck) return res.status(404).json({ error: 'SorДџu tapД±lmadД±' });

    // KRД°TД°K TЖЏHLГњKЖЏSД°ZLД°K YOXLAMASI: sorДџu, tЙ™sdiqlЙ™yЙ™nin Г–Z ЕџirkЙ™tinЙ™ aid olmalД±dД±r (cross-tenant qorunma)
    if (actionCheck.company_id !== approver.company_id) {
      return res.status(403).json({ error: 'Bu sorДџu sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    if (actionCheck.status !== 'pending') {
      return res.status(400).json({ error: 'Bu sorДџu artД±q hЙ™ll olunub' });
    }

    const allowed = await canManageAction(approver, actionCheck);
    if (!allowed) {
      return res.status(403).json({ error: 'Bu sorДџunu tЙ™sdiqlЙ™mЙ™k ГјГ§Гјn icazЙ™niz yoxdur (sЙ™lahiyyЙ™tli departament deyilsiniz)' });
    }

    // Bu approver artД±q tЙ™sdiqlЙ™yibsЙ™, tЙ™krar sayД±lmasД±n
    const { data: existingApproval } = await supabase
      .from('action_approvals')
      .select('id')
      .eq('action_request_id', req.params.id)
      .eq('approver_id', approver.id)
      .maybeSingle();
    if (existingApproval) {
      return res.status(400).json({ error: 'Siz bu sorДџunu artД±q tЙ™sdiqlЙ™misiniz' });
    }

    // Bu tЙ™sdiqi qeydЙ™ al
    await supabase.from('action_approvals').insert({
      action_request_id: req.params.id, approver_id: approver.id, approver_role: approver.role
    });

    // NeГ§Й™ fЙ™rqli tЙ™sdiq toplanД±b, yoxla
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
        approved_at: isFullyApproved ? new Date().toISOString() : null,
        detailed_state: isFullyApproved ? 'COMPLETED' : 'WAITING_APPROVAL'
      })
      .eq('id', req.params.id)
      .select('*, employees!employee_id(name, company_id)')
      .single();
    if (updateError) throw updateError;

    if (isFullyApproved) {
      // ЖЏgЙ™r bu bir mЙ™zuniyyЙ™t sorДџusudursa, Google Calendar-a yaz
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
        `"${updated.title}" sorДџunuz TAM tЙ™sdiqlЙ™ndi вњ…`, updated.id);
    } else {
      // QismЙ™n tЙ™sdiq вЂ” iЕџГ§iyЙ™ vЙ™ qalan tЙ™sdiqlЙ™yicilЙ™rЙ™ mЙ™lumat ver
      createNotification(updated.employees.company_id, updated.employee_id,
        `"${updated.title}" sorДџunuz ${approvalsCount}/${requiredApprovals} tЙ™sdiq aldД± вЂ” daha bir tЙ™sdiq gГ¶zlЙ™nilir.`, updated.id);
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
      .from('action_requests').select('type, employee_id, company_id').eq('id', req.params.id).single();
    if (actionCheckError || !actionCheck) return res.status(404).json({ error: 'SorДџu tapД±lmadД±' });

    // KRД°TД°K TЖЏHLГњKЖЏSД°ZLД°K YOXLAMASI: sorДџu, rЙ™dd edЙ™nin Г–Z ЕџirkЙ™tinЙ™ aid olmalД±dД±r (cross-tenant qorunma)
    if (actionCheck.company_id !== approver.company_id) {
      return res.status(403).json({ error: 'Bu sorДџu sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    const allowed = await canManageAction(approver, actionCheck);
    if (!allowed) {
      return res.status(403).json({ error: 'Bu sorДџunu rЙ™dd etmЙ™k ГјГ§Гјn icazЙ™niz yoxdur (sЙ™lahiyyЙ™tli departament deyilsiniz)' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('action_requests')
      .update({ status: 'rejected', approved_by: approver.id, approved_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw updateError;

    createNotification(updated.company_id, updated.employee_id,
      `"${updated.title}" sorДџunuz rЙ™dd edildi.${reason ? ' SЙ™bЙ™b: ' + reason : ''}`, updated.id);

    res.json({ success: true, action: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Real Undo вЂ” son 5 deqiqe erzinde tesdiq/redd qerarini geri qaytarir ----
// ---- Real Admin Bildirisi вЂ” xeta bas verende, sirketin butun Admin-lerine real bildiris gonderir ----
app.post('/notify-admin', requireAuth, async (req, res) => {
  try {
    const employee = req.employee;
    const { message } = req.body;
    const { data: admins } = await supabase.from('employees').select('id').eq('company_id', employee.company_id).eq('role', 'Admin').eq('status', 'active');
    if (!admins || admins.length === 0) return res.status(404).json({ error: 'ЕћirkЙ™tdЙ™ aktiv Admin tapД±lmadД±' });

    for (const admin of admins) {
      await createNotification(employee.company_id, admin.id, `вљ пёЏ ${employee.name} sistem xЙ™tasД± bildirdi: "${message || 'ЖЏtraflД± mЙ™lumat yoxdur'}"`, null);
    }
    res.json({ success: true, notifiedCount: admins.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/actions/:id/undo', requireAuth, async (req, res) => {
  try {
    const approver = req.employee;
    const { data: actionCheck, error: actionCheckError } = await supabase
      .from('action_requests').select('*').eq('id', req.params.id).single();
    if (actionCheckError || !actionCheck) return res.status(404).json({ error: 'SorДџu tapД±lmadД± вЂ” bu, geri qaytarД±la bilmЙ™yЙ™n bir Й™mЙ™liyyat ola bilЙ™r (mЙ™s. gГ¶ndЙ™rilmiЕџ email)' });

    if (actionCheck.company_id !== approver.company_id) {
      return res.status(403).json({ error: 'Bu sorДџu sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }
    if (actionCheck.status !== 'approved' && actionCheck.status !== 'rejected') {
      return res.status(400).json({ error: 'YalnД±z tЙ™sdiqlЙ™nmiЕџ/rЙ™dd edilmiЕџ sorДџular geri qaytarД±la bilЙ™r' });
    }
    const decidedSecondsAgo = (Date.now() - new Date(actionCheck.approved_at).getTime()) / 1000;
    if (decidedSecondsAgo > 300) {
      return res.status(400).json({ error: 'Bu qЙ™rar 5 dЙ™qiqЙ™dЙ™n Г§ox Й™vvЙ™l verilib, artД±q geri qaytarД±la bilmЙ™z' });
    }

    const { data: reverted, error: revertError } = await supabase
      .from('action_requests')
      .update({ status: 'pending', approved_by: null, approved_at: null, rejection_reason: null })
      .eq('id', req.params.id)
      .select()
      .single();
    if (revertError) throw revertError;

    createNotification(reverted.company_id, reverted.employee_id,
      `"${reverted.title}" sorДџunuz ГјzrЙ™ qЙ™rar geri qaytarД±ldД±, yenidЙ™n gГ¶zlЙ™mЙ™dЙ™dir.`, reverted.id);

    res.json({ success: true, action: reverted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ЕћirkЙ™tin "pending" (gГ¶zlЙ™yЙ™n) sorДџularД±nД± gГ¶stЙ™rir вЂ” Manager Dashboard ГјГ§Гјn Й™sasdД±r.
// IcazЙ™ qaydasД±: Admin -> bГјtГјn ЕџirkЙ™ti gГ¶rГјr.
//   leave_request/expense_request-in nГ¶vГјndЙ™n asД±lД± olmayaraq, DГњZGГњN departamentin manageri gГ¶rmЙ™lidir:
//   - leave_request -> iЕџГ§inin Г–Z departamentinin manageri (Г¶z komandan)
//   - it_ticket -> HЖЏMД°ЕћЖЏ IT departamentinin manageri (kim yaratsa da fЙ™rq etmЙ™z)
//   - expense_request -> HЖЏMД°ЕћЖЏ Finance departamentinin manageri
// ---- Real Proaktiv Teklif вЂ” hec bir uydurma deyil, real Еџertlere esaslanir ----
// ---- Real Fokus PlanД± вЂ” 4 kateqoriyaya, REAL melumatlara esaslanaraq bolur ----
app.get('/focus-plan/:employeeId', requireAuth, async (req, res) => {
  try {
    const employee = req.employee;
    if (employee.id !== req.params.employeeId) return res.status(403).json({ error: 'YalnД±z Г¶z planД±nД±zД± gГ¶rЙ™ bilЙ™rsiniz' });

    const now = new Date();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
    const urgentKeywords = ['tЙ™cili', 'urgent', 'asap', 'dЙ™rhal', 'important', 'vacib'];

    const [emails, { data: todayMeetings }, { data: pendingForMe }] = await Promise.all([
      readRecentEmailsDirect(employee.company_id).catch(() => []),
      supabase.from('meetings').select('title, start_datetime').eq('employee_id', employee.id).eq('status', 'active')
        .gte('start_datetime', now.toISOString()).lte('start_datetime', todayEnd),
      (employee.role === 'Manager' || employee.role === 'Admin')
        ? supabase.from('action_requests').select('id, title, priority, created_at').eq('company_id', employee.company_id).eq('status', 'pending').order('created_at', { ascending: true })
        : Promise.resolve({ data: [] })
    ]);

    const urgentEmails = (emails || []).filter(e => {
      const text = ((e.subject||'') + ' ' + (e.snippet||'')).toLowerCase();
      return urgentKeywords.some(k => text.includes(k));
    });
    const nonUrgentEmails = (emails || []).filter(e => !urgentEmails.includes(e));
    const pending = pendingForMe || [];
    const urgentPending = pending.filter(p => p.priority === 'high');
    const normalPending = pending.filter(p => p.priority !== 'high');

    const nowItems = [
      ...urgentEmails.slice(0,2).map(e => `TЙ™cili email: "${e.subject}"`),
      ...urgentPending.slice(0,2).map(p => `TЙ™cili tЙ™sdiq: "${p.title}"`)
    ];
    const todayItems = [
      ...(todayMeetings||[]).map(m => `GГ¶rГјЕџ: "${m.title}"`),
      ...normalPending.slice(0,2).map(p => `TЙ™sdiq: "${p.title}"`)
    ];
    const laterItems = nonUrgentEmails.slice(0,3).map(e => `Email: "${e.subject}"`);
    const vuseraCanDo = nonUrgentEmails.length > 0 ? [`${nonUrgentEmails.length} email ГјГ§Гјn follow-up draft hazД±rlaya bilЙ™rЙ™m`] : [];

    res.json({
      now: nowItems.length > 0 ? nowItems : ['TЙ™cili iЕџ yoxdur'],
      today: todayItems.length > 0 ? todayItems : ['BugГјn ГјГ§Гјn planlaЕџdД±rД±lan iЕџ yoxdur'],
      later: laterItems.length > 0 ? laterItems : ['GГ¶zlЙ™yЙ™n iЕџ yoxdur'],
      vuseraCanDo: vuseraCanDo.length > 0 ? vuseraCanDo : ['HazД±rda VUSERA-nД±n icra edЙ™ bilЙ™cЙ™yi iЕџ yoxdur'],
      delegatableEmailCount: nonUrgentEmails.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/proactive-suggestion/:employeeId', requireAuth, async (req, res) => {
  try {
    const employee = req.employee;
    if (employee.id !== req.params.employeeId) return res.status(403).json({ error: 'YalnД±z Г¶z tЙ™klifinizi gГ¶rЙ™ bilЙ™rsiniz' });

    const now = new Date();
    const in24h = new Date(now.getTime() + 24*60*60*1000).toISOString();

    // 1) Yaxin 24 saatda gorush varmi?
    const { data: upcomingMeeting } = await supabase
      .from('meetings').select('title, start_datetime').eq('employee_id', employee.id).eq('status', 'active')
      .gte('start_datetime', now.toISOString()).lte('start_datetime', in24h)
      .order('start_datetime', { ascending: true }).limit(1).maybeSingle();
    if (upcomingMeeting) {
      return res.json({ suggestion: `"${upcomingMeeting.title}" gГ¶rГјЕџГјnГјz yaxД±nlaЕџД±r. HazД±rlД±q brifinqi hazД±rlayД±m?`, actionPrompt: `GГ¶rГјЕџЙ™ mЙ™ni hazД±rla: ${upcomingMeeting.title}` });
    }

    // 2) Menecerdirse, 24 saatdan cox gozleyen tesdiq varmi?
    if (employee.role === 'Manager' || employee.role === 'Admin') {
      const yesterday = new Date(now.getTime() - 24*60*60*1000).toISOString();
      const { data: oldPending } = await supabase
        .from('action_requests').select('title').eq('company_id', employee.company_id).eq('status', 'pending')
        .lte('created_at', yesterday).order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (oldPending) {
        return res.json({ suggestion: `"${oldPending.title}" sorДџusu 24 saatdan Г§oxdur gГ¶zlЙ™yir. BaxД±m gedim?`, actionPrompt: `GГ¶zlЙ™yЙ™n tЙ™sdiqlЙ™ri gГ¶stЙ™r` });
      }
    }

    res.json({ suggestion: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/pending-actions/:companyId', requireAuth, async (req, res) => {
  try {
    const viewer = req.employee;
    if (viewer.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
    const today = new Date().toISOString().slice(0, 10);

    // Bu istifadЙ™Г§inin aktiv delegation-larД± (mГјvЙ™qqЙ™ti sЙ™lahiyyЙ™tlЙ™ri) var mД±?
    const { data: myDelegations } = await supabase
      .from('approval_delegations')
      .select('department_name')
      .eq('delegate_id', viewer.id)
      .lte('start_date', today)
      .gte('end_date', today);
    const delegatedDepts = (myDelegations || []).map(d => d.department_name);

    if (!isManagerRole(viewer.role) && viewer.role !== 'Admin' && delegatedDepts.length === 0) {
      return res.status(403).json({ error: 'YalnД±z manager/admin rollarД± (vЙ™ ya delegation almД±Еџ ЕџЙ™xslЙ™r) gГ¶zlЙ™yЙ™n sorДџularД± gГ¶rЙ™ bilЙ™r' });
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
      filtered = data; // Admin hЙ™r Еџeyi gГ¶rГјr
    } else {
      const viewerDeptName = viewer.departments?.name;
      filtered = data.filter(action => {
        const actionDept = action.type === 'it_ticket' ? 'IT' : action.type === 'expense_request' ? 'Finance' : action.type === 'leave_request' ? 'HR' : null;
        if (!actionDept) return false;
        return viewerDeptName === actionDept || delegatedDepts.includes(actionDept);
      });
    }

    // HЙ™r sorДџu ГјГ§Гјn: neГ§Й™ tЙ™sdiq alД±nД±b, bu izlЙ™yici artД±q tЙ™sdiqlЙ™yibmi
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

// BildiriЕџlЙ™r вЂ” istifadЙ™Г§inin Г–Z bildiriЕџlЙ™rini gЙ™tirir (tokendЙ™n mГјЙ™yyЙ™n edilir)
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

// Bir bildiriЕџi "oxunmuЕџ" kimi iЕџarЙ™lЙ™mЙ™k
app.post('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const { data: notifCheck } = await supabase.from('notifications').select('employee_id').eq('id', req.params.id).single();
    if (!notifCheck) return res.status(404).json({ error: 'BildiriЕџ tapД±lmadД±' });
    if (notifCheck.employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Bu bildiriЕџ sizЙ™ aid deyil' });
    }

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

// ЕћirkЙ™t ГјГ§Гјn Гјmumi statistika вЂ” Admin Dashboard-un Й™sasД±
app.get('/dashboard/:companyId', requireAuth, async (req, res) => {  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin dashboard-u gГ¶rЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
    const companyId = req.params.companyId;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const last24h = new Date(now.getTime() - 24*60*60*1000).toISOString();
    const startOfThisWeek = new Date(now.getTime() - 7*24*60*60*1000).toISOString();
    const startOfLastWeek = new Date(now.getTime() - 14*24*60*60*1000).toISOString();

    const [
      { count: employeeCount },
      { count: aiConversations },
      { count: requestCount },
      { count: pendingRequests },
      { count: itTickets },
      { count: expenses },
      { count: tasksExecuted24h },
      { data: completedToday },
      { count: approvedAllTime },
      { count: rejectedAllTime },
      { count: completedThisWeek },
      { count: completedLastWeek },
      { data: last7DaysRaw },
      { count: documentCount },
      { data: integrationsData }
    ] = await Promise.all([
      supabase.from('employees').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
      supabase.from('chat_logs').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'pending'),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('type', 'it_ticket'),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('type', 'expense_request'),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).gte('created_at', last24h),
      supabase.from('action_requests').select('type').eq('company_id', companyId).eq('status', 'approved').gte('approved_at', startOfToday),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'approved'),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'rejected'),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'approved').gte('approved_at', startOfThisWeek),
      supabase.from('action_requests').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'approved').gte('approved_at', startOfLastWeek).lt('approved_at', startOfThisWeek),
      supabase.from('action_requests').select('approved_at').eq('company_id', companyId).eq('status', 'approved').gte('approved_at', startOfLastWeek),
      supabase.from('documents').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('companies').select('google_client_id, slack_bot_token, hubspot_access_token').eq('id', companyId).single()
    ]);

    // HЙ™r tapЕџД±rД±q nГ¶vГјnЙ™ gГ¶rЙ™, tЙ™xmini qЙ™naЙ™t (dЙ™qiqЙ™) вЂ” TIME_SAVED_MINUTES, faylД±n baЕџД±nda qlobal tЙ™yin edilib
    const hoursSavedTodayMinutes = (completedToday || []).reduce((sum, r) => sum + (TIME_SAVED_MINUTES[r.type] || 8), 0);
    const hoursSavedToday = Math.round((hoursSavedTodayMinutes / 60) * 10) / 10;

    // Komanda suretinin heftelik deyisimi (%) - bu heftЙ™ vs kecen hefte tamamlanan sorgular
    let teamVelocityPercent = 0;
    if (completedLastWeek > 0) {
      teamVelocityPercent = Math.round(((completedThisWeek - completedLastWeek) / completedLastWeek) * 100);
    } else if (completedThisWeek > 0) {
      teamVelocityPercent = 100; // kecen hefte 0 idisЙ™, hesablama mumkun deyil, "yeni aktivlik" kimi 100% goster
    }

    // AI deqiqliyi (%) - tesdiqlenen / (tesdiqlenen + reddedilen)
    const totalDecided = (approvedAllTime || 0) + (rejectedAllTime || 0);
    const aiAccuracy = totalDecided > 0 ? Math.round((approvedAllTime / totalDecided) * 100) : null;

    // Son 7 gunun gunluk tamamlanma sayi (avtomatlaЕџdД±rma tempi qrafiki ucun)
    const dailyBuckets = [0,0,0,0,0,0,0];
    (last7DaysRaw || []).forEach(r => {
      const daysAgo = Math.floor((now - new Date(r.approved_at)) / (24*60*60*1000));
      const bucketIndex = 6 - Math.min(6, Math.max(0, daysAgo));
      dailyBuckets[bucketIndex]++;
    });

    // BaglД± inteqrasiya sayi - Google (Gmail+Calendar+Sheets+Drive = 4 xidmet sayilir), Slack, HubSpot
    let connectedIntegrationsCount = 0;
    if (integrationsData?.google_client_id) connectedIntegrationsCount += 4; // Gmail, Calendar, Sheets, Drive
    if (integrationsData?.slack_bot_token) connectedIntegrationsCount += 1;
    if (integrationsData?.hubspot_access_token) connectedIntegrationsCount += 1;

    res.json({
      employeeCount, aiConversations, requestCount, pendingRequests, itTickets, expenses,
      tasksExecuted24h,
      hoursSavedToday,
      teamVelocityPercent,
      aiAccuracy,
      completedThisWeek,
      weeklyAutomationPace: dailyBuckets,
      documentCount,
      connectedIntegrationsCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Advanced Analytics вЂ” Top Questions, Department breakdown, ЖЏn aktiv iЕџГ§ilЙ™r ----
// ---- Approval Delegation (Granular RBAC) вЂ” Admin baЕџqasД±na mГјvЙ™qqЙ™ti tЙ™sdiq sЙ™lahiyyЙ™ti verЙ™ bilЙ™r ----
app.post('/delegations', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin delegation tЙ™yin edЙ™ bilЙ™r' });
    const { delegateId, departmentName, startDate, endDate } = req.body;
    if (!delegateId || !departmentName || !startDate || !endDate) {
      return res.status(400).json({ error: 'delegateId, departmentName, startDate, endDate tЙ™lЙ™b olunur' });
    }
    if (!['IT', 'HR', 'Finance'].includes(departmentName)) {
      return res.status(400).json({ error: 'departmentName "IT", "HR" vЙ™ ya "Finance" olmalД±dД±r' });
    }

    const { data: targetDelegate } = await supabase.from('employees').select('company_id').eq('id', delegateId).single();
    if (!targetDelegate || targetDelegate.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'YalnД±z Г¶z ЕџirkЙ™tinizin iЕџГ§isinЙ™ delegation verЙ™ bilЙ™rsiniz' });
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
      `рџ”‘ SizЙ™ ${startDate} вЂ” ${endDate} tarixlЙ™ri ГјГ§Гјn "${departmentName}" sorДџularД±nД± tЙ™sdiqlЙ™mЙ™ sЙ™lahiyyЙ™ti verildi.`, null);

    res.json({ success: true, delegation: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- ЕћirkЙ™t-sЙ™viyyЙ™li API Key idarЙ™etmЙ™si (Granular RBAC-in davamД±) ----
app.get('/api-key/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin API aГ§arД±nД± gГ¶rЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
    const { data, error } = await supabase.from('companies').select('api_key').eq('id', req.params.companyId).single();
    if (error) throw error;
    res.json({ apiKey: data.api_key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api-key/:companyId/regenerate', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin API aГ§arД±nД± yenilЙ™yЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
    const newKey = crypto.randomBytes(24).toString('hex');
    const { data, error } = await supabase.from('companies').update({ api_key: newKey }).eq('id', req.params.companyId).select('api_key').single();
    if (error) throw error;
    res.json({ success: true, apiKey: data.api_key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- ЕћirkЙ™t-sЙ™viyyЙ™li inteqrasiya aГ§arlarД±nД± tЙ™yin etmЙ™k (hЙ™r mГјЕџtЙ™rinin Г¶z Google/Slack/HubSpot hesabД±) ----
app.post('/companies/:companyId/integrations', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin inteqrasiyalarД± dЙ™yiЕџЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });

    const { googleClientId, googleClientSecret, googleRefreshToken, slackBotToken, hubspotAccessToken } = req.body;
    const updates = {};
    if (googleClientId !== undefined) updates.google_client_id = googleClientId;
    if (googleClientSecret !== undefined) updates.google_client_secret = googleClientSecret;
    if (googleRefreshToken !== undefined) updates.google_refresh_token = googleRefreshToken;
    if (slackBotToken !== undefined) updates.slack_bot_token = slackBotToken;
    if (hubspotAccessToken !== undefined) updates.hubspot_access_token = hubspotAccessToken;

    const { error } = await supabase.from('companies').update(updates).eq('id', req.params.companyId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ЕћirkЙ™tin hansД± inteqrasiyalarД±n QURULU olduДџunu gГ¶stЙ™rir (real aГ§ar dЙ™yЙ™rlЙ™rini AГ‡MADAN)
app.get('/companies/:companyId/integrations', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin gГ¶rЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });

    const { data, error } = await supabase
      .from('companies')
      .select('google_client_id, slack_bot_token, hubspot_access_token')
      .eq('id', req.params.companyId)
      .single();
    if (error) throw error;

    res.json({
      google: !!data.google_client_id,
      slack: !!data.slack_bot_token,
      hubspot: !!data.hubspot_access_token
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Google OAuth "Consent" axД±nД± вЂ” mГјЕџtЙ™rinin Г¶z Google Workspace-inЙ™ qoЕџulmasД± ГјГ§Гјn ----
// AddД±m 1: Admin, Г¶z Google Client ID/Secret-ni saxladД±qdan sonra, bu link-i alД±r vЙ™ kliklЙ™yir
app.get('/oauth/google/start/:companyId', async (req, res) => {
  try {
    const { data: company } = await supabase.from('companies').select('google_client_id').eq('id', req.params.companyId).single();
    if (!company?.google_client_id) return res.status(400).send('ЖЏvvЙ™lcЙ™ Google Client ID/Secret saxlanД±lmalД±dД±r.');

    const redirectUri = `${req.protocol}://${req.get('host')}/oauth/google/callback`;
    const scopes = [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ];
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(company.google_client_id)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent(scopes.join(' '))}&state=${req.params.companyId}`;
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send('XЙ™ta: ' + err.message);
  }
});

// AddД±m 2: Google, istifadЙ™Г§i icazЙ™ verЙ™ndЙ™n sonra, bura "code" ilЙ™ geri qaytarД±r
app.get('/oauth/google/callback', async (req, res) => {
  try {
    const { code, state: companyId } = req.query;
    if (!code || !companyId) return res.status(400).send('XЙ™ta: code vЙ™ ya companyId Г§atД±ЕџmД±r.');

    const { data: company } = await supabase.from('companies').select('google_client_id, google_client_secret').eq('id', companyId).single();
    if (!company?.google_client_id || !company?.google_client_secret) {
      return res.status(400).send('ЕћirkЙ™tin Google aГ§arlarД± tapД±lmadД±.');
    }

    const redirectUri = `${req.protocol}://${req.get('host')}/oauth/google/callback`;
    const oauth2Client = new google.auth.OAuth2(company.google_client_id, company.google_client_secret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.send('<h2>XЙ™ta: refresh_token alД±nmadД±.</h2><p>ZЙ™hmЙ™t olmasa, Google hesabД±ndan "VUSERA" tЙ™tbiqinin icazЙ™sini geri Г§aДџД±rД±b (myaccount.google.com/permissions), yenidЙ™n cЙ™hd edin.</p>');
    }

    await supabase.from('companies').update({ google_refresh_token: tokens.refresh_token }).eq('id', companyId);
    res.send('<h2>вњ… UДџurla baДџlandД±!</h2><p>Bu pЙ™ncЙ™rЙ™ni baДџlaya bilЙ™rsiniz.</p>');
  } catch (err) {
    res.status(500).send('XЙ™ta: ' + err.message);
  }
});

app.get('/delegations/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin gГ¶rЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
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
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin silЙ™ bilЙ™r' });

    const { data: targetDel } = await supabase.from('approval_delegations').select('company_id').eq('id', req.params.id).single();
    if (!targetDel) return res.status(404).json({ error: 'Delegation tapД±lmadД±' });
    if (targetDel.company_id !== req.employee.company_id) {
      return res.status(403).json({ error: 'Bu delegation sizin ЕџirkЙ™tinizЙ™ aid deyil' });
    }

    const { error } = await supabase.from('approval_delegations').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/analytics/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.role !== 'Admin') return res.status(403).json({ error: 'YalnД±z Admin analitikanД± gГ¶rЙ™ bilЙ™r' });
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
    const companyId = req.params.companyId;

    // 1) Top Questions вЂ” Й™n Г§ox tЙ™krarlanan (eyni mЙ™tnli) suallar
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

    // 2) Departament ГјzrЙ™ sorДџu sayД±
    const { data: allRequests } = await supabase
      .from('action_requests')
      .select('type, status, employees!employee_id(departments(name))')
      .eq('company_id', companyId);

    const deptCounts = {};
    (allRequests || []).forEach(r => {
      const dept = r.employees?.departments?.name || 'NamЙ™lum';
      deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    });
    const requestsByDepartment = Object.entries(deptCounts).map(([department, count]) => ({ department, count }));

    // 3) NГ¶v ГјzrЙ™ sorДџu sayД± (leave/it/expense)
    const typeCounts = {};
    (allRequests || []).forEach(r => { typeCounts[r.type] = (typeCounts[r.type] || 0) + 1; });
    const requestsByType = Object.entries(typeCounts).map(([type, count]) => ({ type, count }));

    // 4) Status ГјzrЙ™ sorДџu sayД±
    const statusCounts = {};
    (allRequests || []).forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const requestsByStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

    // 5) ЖЏn aktiv iЕџГ§ilЙ™r (Й™n Г§ox sual verЙ™n, ilk 5)
    const { data: allChats } = await supabase
      .from('chat_logs')
      .select('employee_id, employees!employee_id(name)')
      .eq('company_id', companyId);
    const empCounts = {};
    (allChats || []).forEach(c => {
      const name = c.employees?.name || 'NamЙ™lum';
      empCounts[name] = (empCounts[name] || 0) + 1;
    });
    const mostActiveEmployees = Object.entries(empCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // 6) Management Summary вЂ” real reqemlerden Claude-un yazdigi qisa, narrativ xulase
    let managementSummary = null;
    try {
      const summaryPrompt = `AЕџaДџД±dakД± real ЕџirkЙ™t statistikasД±na Й™sasЙ™n, menecerlЙ™r ГјГ§Гјn 3-4 cГјmlЙ™lik, tЙ™bii dildЙ™ QISA bir xГјlasЙ™ yaz (AzЙ™rbaycan dilindЙ™). RЙ™qЙ™mlЙ™ri tЙ™krar sadalama, Й™vЙ™zinЙ™ mЙ™nalД± bir hekayЙ™/nЙ™ticЙ™ Г§Д±xar (mЙ™s. hansД± departament Й™n yГјklГјdГјr, hansД± sual Й™n Г§ox tЙ™krarlanД±r, diqqЙ™t tЙ™lЙ™b edЙ™n nГ¶qtЙ™ varmД±).

ЖЏn Г§ox verilЙ™n suallar: ${topQuestions.slice(0, 3).map(q => q.question).join('; ') || 'yoxdur'}
Departament ГјzrЙ™ sorДџular: ${requestsByDepartment.map(d => `${d.department}: ${d.count}`).join(', ') || 'yoxdur'}
NГ¶v ГјzrЙ™ sorДџular: ${requestsByType.map(t => `${t.type}: ${t.count}`).join(', ') || 'yoxdur'}
Status ГјzrЙ™: ${requestsByStatus.map(s => `${s.status}: ${s.count}`).join(', ') || 'yoxdur'}
ЖЏn aktiv iЕџГ§ilЙ™r: ${mostActiveEmployees.map(e => `${e.name} (${e.count})`).join(', ') || 'yoxdur'}

YalnД±z xГјlasЙ™ mЙ™tnini yaz, baЕџqa heГ§ nЙ™.`;

      const summaryMsg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 250,
        messages: [{ role: 'user', content: summaryPrompt }]
      });
      managementSummary = summaryMsg.content.map(b => b.text || '').join('').trim();
    } catch (e) {
      console.error('Management summary yaradД±la bilmЙ™di:', e.message);
    }

    res.json({ topQuestions, requestsByDepartment, requestsByType, requestsByStatus, mostActiveEmployees, managementSummary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Proaktiv AI: GГ¶zlЙ™yЙ™n sorДџular ГјГ§Гјn xatД±rlatmalar ----
// Bu endpoint xaricdЙ™n (Make.com-un "scheduled" вЂ” gГјndЙ™lik) Г§aДџД±rД±lmalД±dД±r.
// 2 gГјndЙ™n Г§ox gГ¶zlЙ™yЙ™n sorДџular ГјГ§Гјn: manager-Й™ "hЙ™lЙ™ baxД±lmayД±b" xatД±rlatmasД±,
// iЕџГ§iyЙ™ isЙ™ "sorДџunuz hЙ™lЙ™ gГ¶zlЙ™yir" mЙ™lumatД± gГ¶ndЙ™rir.
app.post('/proactive/check-reminders', async (req, res) => {
  const provided = req.headers['x-owner-secret'];
  if (!process.env.OWNER_SECRET || provided !== process.env.OWNER_SECRET) {
    return res.status(403).json({ error: 'Д°cazЙ™ yoxdur' });
  }
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
        `вЏі XatД±rlatma: "${reqItem.title}" sorДџunuz hЙ™lЙ™ gГ¶zlЙ™yir (${Math.floor((Date.now() - new Date(reqItem.created_at)) / (24*60*60*1000))} gГјndГјr).`,
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
            `вЏі XatД±rlatma: ${emp.name}-in "${reqItem.title}" sorДџusu 2+ gГјndГјr gГ¶zlЙ™yir, hЙ™lЙ™ baxД±lmayД±b.`,
            reqItem.id);
        }
      }

      remindersSent++;
    }

    // ---- GГ¶rГјЕџ xatД±rlatmalarД± вЂ” bugГјn olacaq gГ¶rГјЕџlЙ™r ГјГ§Гјn sЙ™hЙ™r xЙ™bЙ™rdarlД±ДџД± ----
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
        `рџ“… XatД±rlatma: bugГјn saat ${time}-da "${m.title}" gГ¶rГјЕџГјnГјz var.`, null);
      meetingRemindersSent++;
    }

    // ---- IT Auto-Escalation вЂ” yГјksЙ™k prioritetli, 4+ saatdД±r hЙ™ll olunmayan IT ticket-lЙ™ri Admin-Й™ yГјksЙ™ldir ----
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
          `рџљЁ YГњKSЖЏLDД°LDД°: "${ticket.title}" (${emp.name}) вЂ” yГјksЙ™k prioritetli IT problemi 4+ saatdД±r hЙ™ll olunmayД±b!`,
          ticket.id);
      }

      await supabase.from('action_requests').update({ escalated: true }).eq('id', ticket.id);
      escalatedCount++;
    }

    // ---- PREMIUM XГњSUSД°YYЖЏTД°: SLA Д°zlЙ™nmЙ™si вЂ” normal/aЕџaДџД± prioritet ГјГ§Гјn dЙ™ hЙ™dЙ™flЙ™r (Business-dЙ™ yalnД±z "high" izlЙ™nir) ----
    let slaBreachesFlagged = 0;
    const slaTargetsHours = { normal: 24, low: 72 };
    for (const [prio, hours] of Object.entries(slaTargetsHours)) {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const { data: breaches } = await supabase
        .from('action_requests')
        .select('*, employees!employee_id(name, company_id)')
        .eq('type', 'it_ticket').eq('priority', prio).eq('status', 'pending').eq('escalated', false)
        .lt('created_at', cutoff);

      for (const ticket of breaches || []) {
        const emp = ticket.employees;
        if (!emp) continue;
        const { data: companyPlan } = await supabase.from('companies').select('plan_name').eq('id', emp.company_id).single();
        if (companyPlan?.plan_name !== 'Premium') continue; // YalnД±z Premium

        const { data: admins } = await supabase.from('employees').select('id').eq('company_id', emp.company_id).eq('role', 'Admin');
        for (const admin of admins || []) {
          await createNotification(emp.company_id, admin.id,
            `вЏ±пёЏ SLA POZUNTUSU: "${ticket.title}" (${emp.name}) вЂ” "${prio}" prioritetli ticket, ${hours} saatlД±q SLA hЙ™dЙ™fini keГ§ib.`,
            ticket.id);
        }
        await supabase.from('action_requests').update({ escalated: true }).eq('id', ticket.id);
        slaBreachesFlagged++;
      }
    }

    // ---- Automated Follow-up вЂ” 1 gГјn Й™vvЙ™l HЖЏLL OLUNMUЕћ IT ticket-lЙ™r ГјГ§Гјn "tam hЙ™ll olubmu?" sualД± ----
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgoForFollowup = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const { data: resolvedTickets } = await supabase
      .from('action_requests')
      .select('*, employees!employee_id(id, name, company_id)')
      .eq('type', 'it_ticket')
      .eq('status', 'approved')
      .eq('followed_up', false)
      .lt('approved_at', oneDayAgo)
      .gt('approved_at', twoDaysAgoForFollowup);

    let followUpsSent = 0;
    for (const ticket of resolvedTickets || []) {
      const emp = ticket.employees;
      if (!emp) continue;
      await createNotification(emp.company_id, emp.id,
        `рџ”Ѓ XatД±rlatma: "${ticket.title}" problemi dГјnЙ™n hЙ™ll edilmiЕџdi вЂ” tam hЙ™ll olduДџunu tЙ™sdiqlЙ™yirsinizmi? Problem davam edirsЙ™, yeni bir ticket yarada bilЙ™rsiniz.`,
        ticket.id);
      await supabase.from('action_requests').update({ followed_up: true }).eq('id', ticket.id);
      followUpsSent++;
    }

    // ---- PREMIUM XГњSUSД°YYЖЏTД°: CavabsД±z Email AЕџkarlanmasД± ----
    // YalnД±z "Premium" planlД± ЕџirkЙ™tlЙ™r ГјГ§Гјn iЕџlЙ™yir (Business planda mГ¶vcud deyil)
    let unansweredEmailAlertsSent = 0;
    const { data: premiumCompanies } = await supabase
      .from('companies')
      .select('id, name, last_briefing_sent_at')
      .eq('plan_name', 'Premium');

    for (const company of (premiumCompanies || [])) {
      try {
        const emails = await readRecentEmailsDirect(company.id, true);
        const twoDaysAgoMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
        const unanswered = emails.filter(e => e.isUnread && e.internalDate && parseInt(e.internalDate) < twoDaysAgoMs);

        if (unanswered.length > 0) {
          const { data: admins } = await supabase
            .from('employees')
            .select('id')
            .eq('company_id', company.id)
            .eq('role', 'Admin');
          for (const admin of (admins || [])) {
            await createNotification(company.id, admin.id,
              `рџ“§ ${unanswered.length} email 2+ gГјndГјr cavabsД±z qalД±b (mЙ™s: "${unanswered[0].subject}"). Bir baxД±Еџ lazД±m ola bilЙ™r.`,
              null);
            unansweredEmailAlertsSent++;
          }
        }
      } catch (companyErr) {
        console.error(`CavabsД±z email yoxlamasД± uДџursuz oldu (${company.id}):`, companyErr.message);
        // Bu ЕџirkЙ™tin xЙ™tasД±, digЙ™r ЕџirkЙ™tlЙ™rin emalД±nД± dayandД±rmasД±n
      }
    }

    // ---- PREMIUM XГњSUSД°YYЖЏTД°: Avtomatik GГјndЙ™lik Brifinq (gГјndЙ™ YALNIZ 1 dЙ™fЙ™ gГ¶ndЙ™rilir) ----
    let dailyBriefingsSent = 0;
    const todayDateStr = new Date().toISOString().slice(0, 10);
    for (const company of (premiumCompanies || [])) {
      try {
      if (company.last_briefing_sent_at === todayDateStr) continue; // bu gГјn artД±q gГ¶ndЙ™rilib

      let briefingMessages = [{ role: 'user', content: `${company.name} ЕџirkЙ™ti ГјГ§Гјn bu gГјnГјn qД±sa idarЙ™etmЙ™ brifinqini hazД±rla. LazД±m olan alЙ™tlЙ™ri istifadЙ™ et.` }];
      let briefingText = '';
      for (let turn = 0; turn < 5; turn++) {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 1024, tools: briefingTools, messages: briefingMessages
        });
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        briefingText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (toolUseBlocks.length === 0) break;
        briefingMessages.push({ role: 'assistant', content: response.content });
        const toolResults = [];
        for (const tb of toolUseBlocks) {
          const result = await executeBriefingTool(tb.name, company.id);
          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) });
        }
        briefingMessages.push({ role: 'user', content: toolResults });
      }

      if (briefingText) {
        const { data: admins } = await supabase.from('employees').select('id').eq('company_id', company.id).eq('role', 'Admin');
        for (const admin of (admins || [])) {
          await createNotification(company.id, admin.id, `вЂпёЏ GГјndЙ™lik Brifinq: ${briefingText}`, null);
        }
        await supabase.from('companies').update({ last_briefing_sent_at: todayDateStr }).eq('id', company.id);
        dailyBriefingsSent++;
      }
      } catch (companyErr) {
        console.error(`GГјndЙ™lik brifinq uДџursuz oldu (${company.id}):`, companyErr.message);
        // Bu ЕџirkЙ™tin xЙ™tasД±, digЙ™r ЕџirkЙ™tlЙ™rin brifinqini dayandД±rmasД±n
      }
    }

    res.json({ success: true, remindersSent, meetingRemindersSent, escalatedCount, followUpsSent, unansweredEmailAlertsSent, dailyBriefingsSent, slaBreachesFlagged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NamЙ™lum yol (route) ГјГ§Гјn aydД±n xЙ™ta вЂ” DД°QQЖЏT: bu, hЙ™miЕџЙ™ BГњTГњN route-lardan SONRA olmalД±dД±r!
// ---- YALNIZ VUSERA SAHIBI ГњГ‡ГњN вЂ” AI istifadЙ™ xЙ™rci izlЙ™mЙ™si (heГ§ bir mГјЕџtЙ™ri Admin-i bunu gГ¶rЙ™ bilmЙ™z) ----
// Bu endpoint adi iЕџГ§i giriЕџi (requireAuth) ilЙ™ DEYД°L, birbaЕџa API_SECRET ilЙ™ qorunur.
app.get('/internal/cost-tracking', requireAuth, async (req, res) => {
  if (req.employee?.is_platform_owner !== true) return res.status(403).json({ error: 'Д°cazЙ™ yoxdur' });
  const provided = req.headers['x-owner-secret'];
  try {
    const { data: logs } = await supabase
      .from('chat_logs')
      .select('company_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, companies(name)');

    // Claude Sonnet qiymЙ™tlЙ™ri: $3/milyon input token, $15/milyon output token (tЙ™xmini)
    const byCompany = {};
    for (const log of logs || []) {
      const cid = log.company_id;
      if (!byCompany[cid]) byCompany[cid] = { companyName: log.companies?.name || 'NamЙ™lum', inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, conversationCount: 0 };
      byCompany[cid].inputTokens += log.input_tokens || 0;
      byCompany[cid].outputTokens += log.output_tokens || 0;
      byCompany[cid].cacheCreationInputTokens += log.cache_creation_input_tokens || 0;
      byCompany[cid].cacheReadInputTokens += log.cache_read_input_tokens || 0;
      byCompany[cid].conversationCount += 1;
    }

    const result = Object.values(byCompany).map(c => ({
      ...c,
      // Sonnet tЙ™xmini tariflЙ™ri: input $3/M, output $15/M, cache write $3.75/M, cache read $0.30/M.
      estimatedCostUSD: (((Math.max(0, c.inputTokens - c.cacheCreationInputTokens - c.cacheReadInputTokens) / 1000000) * 3) + ((c.cacheCreationInputTokens / 1000000) * 3.75) + ((c.cacheReadInputTokens / 1000000) * 0.30) + ((c.outputTokens / 1000000) * 15)).toFixed(4)
    }));

    const totalCostUSD = result.reduce((sum, c) => sum + parseFloat(c.estimatedCostUSD), 0).toFixed(2);

    res.json({ byCompany: result, totalCostUSD });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- YALNIZ VUSERA SAHIBI ГњГ‡ГњN вЂ” Subscription (abunЙ™lik) idarЙ™etmЙ™si ----
// ---- PREMIUM XГњSUSД°YYЖЏTД°: GГјndЙ™lik Brifinq (RЖЏSMД° Claude Tool-Calling API ilЙ™) ----
// Bu, V2-nin mЙ™tn-Й™saslД± ACTION sistemindЙ™n TAM AYRIDIR вЂ” Claude-un Г¶z tools API-sini istifadЙ™ edir.
// YalnД±z plan_name = 'Premium' olan ЕџirkЙ™tlЙ™r ГјГ§Гјn iЕџlЙ™yir.

const briefingTools = [
  {
    name: 'get_pending_approvals_count',
    description: 'ЕћirkЙ™tdЙ™ hazД±rda tЙ™sdiq gГ¶zlЙ™yЙ™n sorДџularД±n sayД±nД± qaytarД±r',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_todays_meetings',
    description: 'Bu gГјn planlaЕџdД±rД±lmД±Еџ gГ¶rГјЕџlЙ™rin siyahД±sД±nД± qaytarД±r',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_overdue_requests_count',
    description: '2 gГјndЙ™n Г§ox gГ¶zlЙ™yЙ™n (gecikmiЕџ) sorДџularД±n sayД±nД± qaytarД±r',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

async function executeBriefingTool(toolName, companyId) {
  if (toolName === 'get_pending_approvals_count') {
    const { count } = await supabase.from('action_requests').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).eq('status', 'pending');
    return { count: count || 0 };
  }
  if (toolName === 'get_todays_meetings') {
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    const { data } = await supabase.from('meetings').select('title, meeting_time')
      .eq('company_id', companyId).eq('status', 'active')
      .gte('meeting_time', todayStart.toISOString()).lte('meeting_time', todayEnd.toISOString());
    return { meetings: (data || []).map(m => ({ title: m.title, time: m.meeting_time })) };
  }
  if (toolName === 'get_overdue_requests_count') {
    const twoDaysAgo = new Date(Date.now() - 2*24*60*60*1000).toISOString();
    const { count } = await supabase.from('action_requests').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).eq('status', 'pending').lt('created_at', twoDaysAgo);
    return { count: count || 0 };
  }
  return { error: 'namЙ™lum alЙ™t' };
}

app.post('/premium/daily-briefing/:companyId', async (req, res) => {
  const provided = req.headers['x-owner-secret'];
  if (!process.env.OWNER_SECRET || provided !== process.env.OWNER_SECRET) {
    return res.status(403).json({ error: 'Д°cazЙ™ yoxdur' });
  }
  try {
    const { data: company } = await supabase.from('companies').select('plan_name, name').eq('id', req.params.companyId).single();
    if (!company || company.plan_name !== 'Premium') {
      return res.status(403).json({ error: 'Bu funksiya yalnД±z Premium planlД± ЕџirkЙ™tlЙ™r ГјГ§ГјndГјr' });
    }

    let messages = [{ role: 'user', content: `${company.name} ЕџirkЙ™ti ГјГ§Гјn bu gГјnГјn qД±sa idarЙ™etmЙ™ brifinqini hazД±rla. LazД±m olan alЙ™tlЙ™ri istifadЙ™ et.` }];
    let finalText = '';

    for (let turn = 0; turn < 5; turn++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        tools: briefingTools,
        messages
      });

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const textBlocks = response.content.filter(b => b.type === 'text');
      finalText = textBlocks.map(b => b.text).join('\n');

      if (toolUseBlocks.length === 0) break; // Claude bitirib, cavab hazД±rdД±r

      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const tb of toolUseBlocks) {
        const result = await executeBriefingTool(tb.name, req.params.companyId);
        toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    res.json({ success: true, briefing: finalText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- PREMIUM XГњSUSД°YYЖЏTД°: Webhook/API Trigger ----
// Xarici sistemlЙ™r (monitorinq alЙ™tlЙ™ri, xarici formlar vЙ™ s.), ЕџirkЙ™tin Г¶z API aГ§arД± ilЙ™,
// birbaЕџa VUSERA-da sorДџu yarada bilЙ™r вЂ” chat interfeysindЙ™n kЙ™nar.
app.post('/webhook/trigger/:companyId', async (req, res) => {
  try {
    const apiKey = req.headers['x-webhook-key'];
    if (!apiKey) return res.status(401).json({ error: 'x-webhook-key baЕџlД±ДџД± tЙ™lЙ™b olunur' });

    const { data: company } = await supabase
      .from('companies')
      .select('id, plan_name, api_key')
      .eq('id', req.params.companyId)
      .single();
    if (!company) return res.status(404).json({ error: 'ЕћirkЙ™t tapД±lmadД±' });
    if (company.api_key !== apiKey) return res.status(403).json({ error: 'API aГ§arД± yanlД±ЕџdД±r' });
    if (company.plan_name !== 'Premium') {
      return res.status(403).json({ error: 'Webhook trigger yalnД±z Premium planlД± ЕџirkЙ™tlЙ™r ГјГ§ГјndГјr' });
    }

    const { type, title, detail, priority } = req.body;
    if (!type || !title) return res.status(400).json({ error: 'type vЙ™ title tЙ™lЙ™b olunur' });
    if (!['it_ticket', 'leave_request', 'expense_request'].includes(type)) {
      return res.status(400).json({ error: 'type "it_ticket", "leave_request" vЙ™ ya "expense_request" olmalД±dД±r' });
    }

    // Webhook-la yaradД±lan sorДџu, ilk Admin-Й™ mЙ™nsub edilir (webhook-un "iЕџГ§isi" yoxdur)
    const { data: admin } = await supabase.from('employees').select('id').eq('company_id', company.id).eq('role', 'Admin').limit(1).single();
    if (!admin) return res.status(400).json({ error: 'ЕћirkЙ™tdЙ™ Admin tapД±lmadД±' });

    // IDEMPOTENCY: xarici sistemin tЙ™sadГјfЙ™n eyni webhook-u 2 dЙ™fЙ™ gГ¶ndЙ™rmЙ™sinin qarЕџД±sД±nД± al
    // (mЙ™s: ЕџЙ™bЙ™kЙ™ vaxtД± bitЙ™ndЙ™ avtomatik tЙ™krar cЙ™hd) вЂ” eyni mЙ™zmun, son 60 saniyЙ™dЙ™
    const webhookFingerprint = crypto.createHash('sha256')
      .update(`webhook:${company.id}:${type}:${title}:${detail || ''}`)
      .digest('hex');
    const sixtySecondsAgoWebhook = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: existingWebhookCall } = await supabase
      .from('action_fingerprints')
      .select('id')
      .eq('fingerprint', webhookFingerprint)
      .eq('employee_id', admin.id)
      .gte('created_at', sixtySecondsAgoWebhook)
      .maybeSingle();
    if (existingWebhookCall) {
      return res.json({ success: true, duplicate: true, message: 'Bu sorДџu artД±q son 60 saniyЙ™dЙ™ qЙ™bul edilib, tЙ™krar yaradД±lmadД±' });
    }
    await supabase.from('action_fingerprints').insert({ fingerprint: webhookFingerprint, employee_id: admin.id });

    const { data: created, error } = await supabase
      .from('action_requests')
      .insert({
        company_id: company.id,
        employee_id: admin.id,
        type, title, detail: detail || '',
        priority: priority || 'normal',
        status: 'pending',
        detailed_state: 'WAITING_APPROVAL',
        retry_count: 0
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, requestId: created.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- PREMIUM XГњSUSД°YYЖЏTД°: HR AnalitikasД± ----
app.get('/premium/hr-analytics/:companyId', requireAuth, async (req, res) => {
  try {
    if (req.employee.company_id !== req.params.companyId) return res.status(403).json({ error: 'Bu ЕџirkЙ™tЙ™ giriЕџiniz yoxdur' });
    if (req.employee.role !== 'Admin' && !req.employee.role.includes('HR')) return res.status(403).json({ error: 'YalnД±z Admin/HR gГ¶rЙ™ bilЙ™r' });

    const { data: company } = await supabase.from('companies').select('plan_name').eq('id', req.params.companyId).single();
    if (company?.plan_name !== 'Premium') return res.status(403).json({ error: 'Bu funksiya yalnД±z Premium planlД± ЕџirkЙ™tlЙ™r ГјГ§ГјndГјr' });

    // Departament ГјzrЙ™ iЕџГ§i sayД±
    const { data: employees } = await supabase.from('employees').select('id, status, departments(name)').eq('company_id', req.params.companyId);
    const activeCount = (employees || []).filter(e => e.status === 'active').length;
    const byDept = {};
    for (const e of (employees || [])) {
      const d = e.departments?.name || 'NamЙ™lum';
      byDept[d] = (byDept[d] || 0) + 1;
    }

    // MЙ™zuniyyЙ™t sorДџularД±nД±n orta tЙ™sdiq mГјddЙ™ti (gГјn olaraq)
    const { data: leaveRequests } = await supabase
      .from('action_requests')
      .select('created_at, approved_at')
      .eq('company_id', req.params.companyId)
      .eq('type', 'leave_request')
      .eq('status', 'approved')
      .not('approved_at', 'is', null);

    let avgApprovalDays = null;
    if (leaveRequests && leaveRequests.length > 0) {
      const totalDays = leaveRequests.reduce((sum, r) => sum + (new Date(r.approved_at) - new Date(r.created_at)) / (24*60*60*1000), 0);
      avgApprovalDays = (totalDays / leaveRequests.length).toFixed(1);
    }

    res.json({
      activeEmployeeCount: activeCount,
      employeesByDepartment: byDept,
      avgLeaveApprovalDays: avgApprovalDays,
      totalLeaveRequestsAnalyzed: (leaveRequests || []).length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/internal/subscriptions', async (req, res) => {
  const provided = req.headers['x-owner-secret'];
  if (!process.env.OWNER_SECRET || provided !== process.env.OWNER_SECRET) {
    return res.status(403).json({ error: 'Д°cazЙ™ yoxdur' });
  }
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, subscription_status, plan_name, monthly_amount, next_billing_date')
      .order('name');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/internal/subscriptions/:companyId', async (req, res) => {
  const provided = req.headers['x-owner-secret'];
  if (!process.env.OWNER_SECRET || provided !== process.env.OWNER_SECRET) {
    return res.status(403).json({ error: 'Д°cazЙ™ yoxdur' });
  }
  try {
    const { subscriptionStatus, planName, monthlyAmount, nextBillingDate } = req.body;
    const updates = {};
    if (subscriptionStatus) updates.subscription_status = subscriptionStatus;
    if (planName) updates.plan_name = planName;
    if (monthlyAmount !== undefined) updates.monthly_amount = monthlyAmount;
    if (nextBillingDate) updates.next_billing_date = nextBillingDate;

    const { data, error } = await supabase
      .from('companies')
      .update(updates)
      .eq('id', req.params.companyId)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, company: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- VUSERA AI Growth Agency ----
registerGrowthAgencyRoutes({ app, supabase, anthropic, requireAuth, sendEmail: sendEmailViaMake });

app.use((req, res) => {
  res.status(404).json({ error: 'Bu Гјnvan tapД±lmadД±' });
});

// ЖЏn son, gГ¶zlЙ™nilmЙ™z bГјtГјn xЙ™talar ГјГ§Гјn Гјmumi tutucu (server Г§Г¶kmЙ™sin deyЙ™)
app.use((err, req, res, next) => {
  console.error('GГ¶zlЙ™nilmЙ™z xЙ™ta:', err);
  res.status(500).json({ error: 'Daxili server xЙ™tasД± baЕџ verdi' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`рџљЂ VUSERA Copilot API ${PORT} portunda iЕџlЙ™yir`));

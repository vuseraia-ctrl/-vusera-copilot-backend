# VUSERA AI Growth Agency API

Bütün endpointlər `Authorization: Bearer <token>` və və mövcud `x-api-secret` header-i ilə işləyir. İstifadəçi Manager/Admin olmalıdır. `company_id` URL və body-dən qəbul edilmir; authenticated işçidən götürülür.

| Metod | Endpoint | Funksiya |
|---|---|---|
| GET | `/growth/agents/status` | Beş agentin statusu |
| GET | `/growth/overview` | Pipeline statistikası |
| GET | `/growth/leads` | Lead siyahısı və filtrlər |
| POST | `/growth/leads` | Yeni lead |
| POST | `/growth/leads/import` | Maksimum 100 lead idxalı |
| POST | `/growth/leads/discover` | AI ilə maksimum 20 yeni lead namizədi tap və `Araşdırılır` statusunda əlavə et |
| PATCH | `/growth/leads/:id` | Lead/status yeniləmə |
| DELETE | `/growth/leads/:id` | Lead silmə |
| POST | `/growth/leads/:id/generate-draft` | Claude ilə fərdi draft |
| GET | `/growth/drafts` | Draft və təsdiq növbəsi |
| POST | `/growth/drafts/:id/approve` | Draft təsdiqi |
| POST | `/growth/drafts/:id/reject` | Draft rəddi |
| POST | `/growth/drafts/:id/send` | Təsdiqlənmiş email göndərişi |
| POST | `/growth/sprints` | Maksimum 5 lead üçün gündəlik sprint |
| GET | `/growth/activities` | Growth audit fəaliyyəti |

## Nümunə: lead yarat

```json
{
  "companyName": "CELT Colleges",
  "priority": "A",
  "sector": "Təhsil",
  "contactName": "CELT rəhbərliyi",
  "contactRole": "Operations",
  "primaryChannel": "Instagram / Telefon",
  "pilotScenario": "Müraciət → sənəd analizi → cavab draftı → konsultasiya görüşü → audit"
}
```

## Nümunə: sprint

```json
{ "limit": 5 }
```

## Nümunə: email göndərişi

Draft əvvəl `/approve` ilə təsdiqlənməlidir. Sonra:

```json
{ "confirmFirstContact": true }
```

Bu əməliyyat geri qaytarılmır. Default limit bir şirkət üçün 24 saatda 10 cold-emaildir.

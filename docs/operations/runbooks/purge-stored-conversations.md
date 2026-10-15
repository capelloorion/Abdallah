# Runbook — Removing a conversation or message from Azure SQL

**When to use:** someone asks for stored chat content to be removed, or an operator finds content
that must go: a pasted password or key, personal data, or a harmful answer. The api has **no
delete, rename or edit endpoint on purpose** (ADR-0014), and conversations are shared, so the only
way to remove content is an operator running SQL on the production database. Rows live in
`conversations` and `messages`. A `messages.conversation_id` foreign key is `NO ACTION`, so
**messages go first**.

Roadmap api:5.7; threat model [`shared-conversations`](../../security/threat-models/shared-conversations.md)
(P3, R3, Rp3, I2, I3, I5).

> Deleting rows **does not undo an exposure**. The text may already have been read by every user,
> sent to the model deployment as history, echoed into a later stored answer, and copied into
> database backups. Steps 1 and 6 matter as much as the delete.

## Decisions this runbook depends on

These are the team's to make; until they are filled in, the procedure below is still safe to run
but the operator must not invent the answers.

| Decision                                                  | Value                               |
| --------------------------------------------------------- | ----------------------------------- |
| Who may run this (a named Entra group, not a person)      | _not decided — threat model Q1/Q8_  |
| Who owns erasure requests (receives and approves them)    | _not decided_                       |
| Retention period for conversations and messages           | _not decided (or "forever")_        |
| Real backup / point-in-time-restore retention of prod SQL | _unknown — ask the cloud team (Q4)_ |

Fill the table in as soon as the answers are known, and update the "Backups" step with the real
number.

## Who may do it

- Only members of the named admin group (above) with data-plane access to the production database
  through Entra ID. Do it as yourself, not as the api's identity or a shared login, so the audit
  trail names a person.
- A second person (the erasure-request owner) approves the predicate **before** the delete runs.
- No developer IPs or shared SQL logins on production. If you can only reach the database from an
  unlisted address, stop; do not open a firewall rule for it.

## Procedure

### 1. If the content is a credential, rotate it first

Treat a pasted key, token, password or connection string as **compromised**, whatever you do to the
row. Rotation is maintainer-owned (Key Vault, the service that issued it). Do this before or in
parallel with the purge, never "after the delete".

### 2. Identify the rows without logging content

Logs carry no conversation or message ids and no text (rule 70), so a row cannot be found from
telemetry, and the chat page has no per-conversation URL. Ask the requester for the chat's title
(the list shows it: it is the first question, shortened) and roughly when it was written, then find
the row by that. Read **only as much as needed** to be sure it is the right row, and do not copy
content into tickets, chat or logs.

```sql
-- Find candidates by time window; titles are user text, so look at them but do not copy them out.
SELECT id, title, created_at, updated_at
FROM conversations
WHERE updated_at BETWEEN @from AND @to          -- declare @from / @to as datetime2 (UTC)
ORDER BY updated_at DESC;
```

```sql
-- Bound values: replace only the DECLARE lines. Never paste text into the predicate of a delete.
DECLARE @conversation_id uniqueidentifier = '00000000-0000-0000-0000-000000000000';

SELECT id, role, created_at, LEN(content) AS content_length
FROM messages
WHERE conversation_id = @conversation_id
ORDER BY created_at, role;       -- no `content` column: lengths and times are enough to pick rows
```

### 3. Get the predicate approved

Write down, in the incident note (step 5), exactly what will be removed: the conversation id, and
either "the whole conversation" or the message ids. The approver agrees to that, not to a
description.

### 4. Delete in one transaction, check the counts, then commit

Run it in a tool that supports variables (`sqlcmd` or Azure Data Studio), as the named admin.
Choose **one** of the two blocks.

**Remove a whole conversation** (its messages first):

```sql
DECLARE @conversation_id uniqueidentifier = '00000000-0000-0000-0000-000000000000';
DECLARE @expected_messages int = 0;      -- from the SELECT in step 2

BEGIN TRANSACTION;

DELETE FROM messages WHERE conversation_id = @conversation_id;
DECLARE @deleted_messages int = @@ROWCOUNT;

DELETE FROM conversations WHERE id = @conversation_id;
DECLARE @deleted_conversations int = @@ROWCOUNT;

SELECT @deleted_messages AS deleted_messages, @deleted_conversations AS deleted_conversations;

IF @deleted_conversations = 1 AND @deleted_messages = @expected_messages
    COMMIT TRANSACTION;
ELSE
BEGIN
    ROLLBACK TRANSACTION;
    THROW 50001, 'Unexpected row counts: rolled back. Nothing was deleted.', 1;
END
```

**Remove one or more messages but keep the conversation** (for example one bad answer):

```sql
DECLARE @conversation_id uniqueidentifier = '00000000-0000-0000-0000-000000000000';
DECLARE @message_id uniqueidentifier = '00000000-0000-0000-0000-000000000000';   -- repeat the block per message

BEGIN TRANSACTION;

DELETE FROM messages WHERE id = @message_id AND conversation_id = @conversation_id;
DECLARE @deleted_messages int = @@ROWCOUNT;

SELECT @deleted_messages AS deleted_messages;

IF @deleted_messages = 1
    COMMIT TRANSACTION;
ELSE
BEGIN
    ROLLBACK TRANSACTION;
    THROW 50001, 'Unexpected row count: rolled back. Nothing was deleted.', 1;
END
```

Two things that are easy to miss when only a message is removed:

- **The title is the first question.** A conversation called after a question that contained the
  pasted text still shows it in the list. If the first question is the one removed, also reset the
  title (keep the same transaction):
  `UPDATE conversations SET title = N'New conversation' WHERE id = @conversation_id;`
- **Answers can quote the question.** If the model echoed the text, the next assistant message holds
  it too. Look at the message after the removed one (`role = 'assistant'`) and remove it as well
  when it does.

### 5. Record what was removed — counts and ids, never content

In the incident or request ticket (not in chat, not in logs) write:

- the date and time (UTC), the requester's reference, the approver and the operator;
- the conversation id, the message ids removed, the counts from the transaction output;
- the reason class only (`credential`, `personal data`, `harmful answer`, `other`);
- whether a credential was rotated, and when.

**Never** put the removed text, the title or a screenshot of it in the note. The note exists so
"it was removed, by whom, when" can be answered later (threat model Rp3).

### 6. The copies you did not delete

| Where                                        | What to do                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Database backups / point-in-time restore** | They keep the row until they age out. State the retention in the ticket (see _Decisions_). Do **not** restore an older copy over production: it brings the content back. |
| **Model deployment (Foundry)**               | Recent questions were sent as history (the last 10 messages). Its retention belongs to the cloud team (threat model R6): ask them if the requester needs it covered.     |
| **Logs (Log Analytics)**                     | Logs carry no content by design. If a leak into telemetry is suspected, use [pii-purge](pii-purge.md).                                                                   |
| **Someone's copy or screenshot**             | Cannot be recalled. Tell the requester.                                                                                                                                  |

### 7. Check

- [ ] The `SELECT` from step 2 now returns no rows (or only the rows meant to stay).
- [ ] `GET /v1/conversations/<id>` on the api answers `404 not_found` for a removed conversation;
      for a kept one it no longer returns the removed text, and the chat list no longer shows it in
      the title.
- [ ] A credential was rotated, and the ticket says when.
- [ ] The ticket holds counts and ids, no content.

## What this runbook does not cover

- A delete endpoint, a retention job or "delete my chat" in the UI: there is none (ADR-0014); adding
  one needs an authentication decision, a threat-model update and an ADR first.
- Content in the knowledge base (documents in Azure AI Search): see the ingest threat model and
  its own runbook once the ingest decisions are made.
- Purging Log Analytics: [pii-purge](pii-purge.md).

## References

- ADR-0014 (shared conversations, no delete path) · threat model
  [`shared-conversations`](../../security/threat-models/shared-conversations.md) (R3, P3, Rp3, Q1, Q4, Q8)
- [pii-purge](pii-purge.md) for logs · `apps/api/app/models/conversation.py` for the tables

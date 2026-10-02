'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Bot, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AiKnowledgeCard } from '@/components/settings/ai-knowledge';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import type { AccountMember } from '@/types';

const MODELS = [
  ['claude-haiku-4-5-20251001', 'modelHaiku'],
  ['claude-sonnet-5-5', 'modelSonnet'],
  ['claude-opus-5-5', 'modelOpus'],
] as const;

export interface AiAgent {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model: string;
  welcome_message: string | null;
  handoff_user_id: string | null;
  max_replies: number;
  is_active: boolean;
}

const COLUMNS =
  'id, name, description, system_prompt, model, welcome_message, handoff_user_id, max_replies, is_active';

const EMPTY: Omit<AiAgent, 'id'> = {
  name: '',
  description: '',
  system_prompt: '',
  model: MODELS[0][0],
  welcome_message: '',
  handoff_user_id: null,
  max_replies: 20,
  is_active: true,
};

/**
 * Self-contained AI agents (ai_agents): instructions, model, welcome message,
 * handoff target, reply cap and their own knowledge base. Only the provider
 * key is global (Setup tab). A flow hands a conversation to an agent via the
 * "Transferir" node.
 */
export function AiAgents() {
  const t = useTranslations('Agents.agents');
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasEmbeddingsKey, setHasEmbeddingsKey] = useState(false);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<AccountMember[]>([]);

  const load = useCallback(
    () =>
      createClient()
        .from('ai_agents')
        .select(COLUMNS)
        .order('name')
        .then(({ data, error }) => {
          if (error) toast.error(t('loadFailed'));
          setAgents((data as AiAgent[]) ?? []);
          setLoading(false);
        }),
    [t],
  );

  useEffect(() => {
    void load();
    void fetch('/api/ai/config')
      .then((r) => r.json())
      .then((d) => setHasEmbeddingsKey(Boolean(d?.has_embeddings_key)))
      .catch(() => {});
    void fetchAccountMembers().then(setMembers);
  }, [load]);

  const edit = (agent: AiAgent | null) => {
    setEditingId(agent?.id ?? 'new');
    setForm(agent ? { ...agent, description: agent.description ?? '', welcome_message: agent.welcome_message ?? '' } : EMPTY);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    setSaving(true);
    const row = {
      name: form.name.trim(),
      description: form.description?.trim() || null,
      system_prompt: form.system_prompt.trim(),
      model: form.model,
      welcome_message: form.welcome_message?.trim() || null,
      handoff_user_id: form.handoff_user_id || null,
      max_replies: Math.min(100, Math.max(1, Math.round(form.max_replies) || 20)),
      is_active: form.is_active,
      updated_at: new Date().toISOString(),
    };
    const db = createClient().from('ai_agents');
    const isNew = editingId === 'new';
    const { data, error } = isNew
      ? await db.insert({ ...row, account_id: accountId }).select('id').single()
      : await db.update(row).eq('id', editingId).select('id').single();
    setSaving(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('saved'));
    // A new agent stays open so its own knowledge base can be filled in.
    setEditingId(isNew ? (data?.id ?? null) : null);
    void load();
  };

  const remove = async (agent: AiAgent) => {
    if (!window.confirm(t('confirmDelete', { name: agent.name }))) return;
    const { error } = await createClient().from('ai_agents').delete().eq('id', agent.id);
    if (error) toast.error(t('deleteFailed'));
    else setAgents((list) => list.filter((a) => a.id !== agent.id));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {agents.length === 0 && editingId === null && (
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
            )}
            {agents.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {agents.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {a.name}
                        {!a.is_active && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">({t('inactive')})</span>
                        )}
                      </p>
                      {a.description && (
                        <p className="truncate text-xs text-muted-foreground">{a.description}</p>
                      )}
                    </div>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => edit(a)} title={t('edit')}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(a)}
                          title={t('delete')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editingId !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="agent-name">{t('name')}</Label>
                    <Input
                      id="agent-name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder={t('namePlaceholder')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agent-desc">{t('descriptionLabel')}</Label>
                    <Input
                      id="agent-desc"
                      value={form.description ?? ''}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder={t('descriptionPlaceholder')}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-prompt">{t('prompt')}</Label>
                  <Textarea
                    id="agent-prompt"
                    value={form.system_prompt}
                    onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                    placeholder={t('promptPlaceholder')}
                    rows={12}
                  />
                  <p className="text-xs text-muted-foreground">{t('promptHelp')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-welcome">{t('welcome')}</Label>
                  <Textarea
                    id="agent-welcome"
                    value={form.welcome_message ?? ''}
                    onChange={(e) => setForm({ ...form, welcome_message: e.target.value })}
                    placeholder={t('welcomePlaceholder')}
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">{t('welcomeHelp')}</p>
                </div>
                <div className="space-y-2">
                  <Label>{t('handoffTo')}</Label>
                  <Select
                    value={form.handoff_user_id || '__queue__'}
                    onValueChange={(v) => setForm({ ...form, handoff_user_id: v === '__queue__' ? null : (v ?? null) })}
                  >
                    <SelectTrigger className="bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__queue__">{t('handoffQueue')}</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {memberLabel(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="agent-model">{t('model')}</Label>
                    <Select
                      value={form.model}
                      onValueChange={(v) => v && setForm({ ...form, model: v })}
                    >
                      <SelectTrigger id="agent-model" className="bg-muted">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MODELS.map(([id, label]) => (
                          <SelectItem key={id} value={id}>
                            {t(label)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agent-max">{t('maxReplies')}</Label>
                    <Input
                      id="agent-max"
                      type="number"
                      min={1}
                      max={100}
                      value={form.max_replies}
                      onChange={(e) => setForm({ ...form, max_replies: Number(e.target.value) })}
                    />
                  </div>
                  <label className="flex items-center gap-2 pt-6 text-sm">
                    <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
                    {t('active')}
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">{t('maxRepliesHelp')}</p>
                {editingId === 'new' ? (
                  <p className="text-xs text-muted-foreground">{t('saveFirstForKnowledge')}</p>
                ) : (
                  <AiKnowledgeCard
                    key={editingId}
                    accountId={accountId}
                    canEdit={canEdit}
                    hasEmbeddingsKey={hasEmbeddingsKey}
                    agentId={editingId}
                  />
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setEditingId(null)} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('save')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <Button variant="outline" size="sm" onClick={() => edit(null)}>
                  <Plus className="mr-2 h-4 w-4" /> {t('add')}
                </Button>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

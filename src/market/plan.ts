import { AgentConnection, PrismaClient } from '@prisma/client';
import { AgentDevService } from '../agentdev/AgentDevService';
import { AgentWalletService } from '../services/AgentWalletService';
import { BazaarBridge } from '../bazaar/BazaarBridge';
import { AgencyService } from '../agency/AgencyService';
import { findService } from './catalog';
import { SelectionKind, findPlatform } from './directory';
import { serviceAllowed } from './GasService';

// ---------------------------------------------------------------------------
// The marketplace "plan": after an owner selects platforms, services, Bazaar agents and data agents for one
// of their agents, what is still needed before the agent can actually use each one, and how it uses it.
//
//   agent basics   funded wallet · signed Power of Agency · a connected assistant · selections reach its connections
//   per selection  ready / to do / blocked, the one next action, and how the agent uses it (prompt + MCP tools + HTTP)
//
// Read-only: actions are performed by the existing owner endpoints (grant, connect, extend access, sign, buy…).
// ---------------------------------------------------------------------------

export type PlanState = 'done' | 'todo' | 'blocked';
export type PlanAction =
  | { type: 'fund'; label: string; href: string }
  | { type: 'sign'; label: string }
  | { type: 'connect'; label: string; platform?: string }
  | { type: 'extend'; label: string; connections: Array<{ id: string; label: string; addScopes: string[]; addServices: string[] }> }
  | { type: 'grant'; label: string; capability: string }
  | { type: 'enable_bazaar'; label: string }
  | { type: 'open'; label: string; item: string }
  | { type: 'attest'; label: string; item: string; runs: number };

export interface PlanItem {
  key: string;
  kind: 'agent' | SelectionKind;
  id: string;
  title: string;
  state: PlanState;
  status: string;
  action?: PlanAction;
  howTo?: { prompt: string; tools: string[]; http?: string };
}

const usd = (m: bigint | number) => `$${(Number(m) / 100).toFixed(2)}`;

/** Scopes and mandate service ids a selection needs on a connection. */
export function needsFor(items: Array<{ kind: SelectionKind; id: string }>) {
  const scopes = new Set<string>(), services = new Set<string>();
  for (const i of items) {
    if (i.kind === 'service') { scopes.add('market:read'); scopes.add('gas:pay'); services.add(i.id); }
    if (i.kind === 'bazaar') { scopes.add('bazaar:buy'); services.add('agentbazaar'); }
    if (i.kind === 'data') { scopes.add('data:query'); services.add(`data:${i.id}`); }
    if (i.kind === 'skill') { scopes.add('market:read'); scopes.add('gas:pay'); services.add('skills'); }
  }
  return { scopes: [...scopes], services: [...services] };
}

export async function buildPlan(d: {
  prisma: PrismaClient; dev: AgentDevService; wallet: AgentWalletService; bazaar?: BazaarBridge | null; agency?: AgencyService | null;
  /** Live portal status per service (the stack runs sandbox portals); defaults to the catalog's. */
  portalStatus?: (serviceId: string) => string | undefined;
}, agentId: string) {
  const agent = await d.prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error('AGENT_NOT_FOUND');
  const rows = await d.prisma.marketSelection.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } });
  const items = rows.map((r) => ({ kind: r.kind as SelectionKind, id: r.itemId }));
  const [balance, caps, score, conns, svcOrders, subs, queries] = await Promise.all([
    d.wallet.getBalance(agentId, 'USD'),
    d.dev.skills.capabilitiesFor(agentId),
    d.dev.score.getAccount(agentId),
    d.prisma.agentConnection.findMany({ where: { agentId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }),
    d.prisma.serviceOrder.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    d.prisma.dataSubscription.findMany({ where: { buyerAgentId: agentId, status: 'ACTIVE' } }),
    d.prisma.dataQuery.findMany({ where: { buyerAgentId: agentId }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  const has = (cap: string) => !!score && caps.some((c: any) => c.capability === cap && !c.revokedAt);
  const bz = d.bazaar ? await d.bazaar.status(agentId).catch(() => null) : null;
  const listings = d.bazaar && items.some((i) => i.kind === 'bazaar') ? await d.bazaar.search({}).then((r) => r.results).catch(() => []) : [];
  const anyPaid = (bz?.orders ?? []).some((o: any) => o.status === 'PAID' && items.some((i) => i.kind === 'bazaar' && i.id === o.solutionId));
  const pending: Array<{ run_id: string; solution_id: string }> = d.bazaar && anyPaid ? await d.bazaar.pending(agent.ownerId).then((r: any) => r.pending ?? []).catch(() => []) : [];
  const dataAgents = await d.prisma.dataAgent.findMany({ where: { slug: { in: items.filter((i) => i.kind === 'data').map((i) => i.id) } } });
  const plan: PlanItem[] = [];
  const agentHref = `/dashboard?agent=${encodeURIComponent(agentId)}`;
  const connNames = (cs: AgentConnection[]) => cs.map((c) => c.label).join(', ');

  // ---- agent basics -------------------------------------------------------
  if (!agent.isActive) plan.push({ key: 'agent:active', kind: 'agent', id: 'active', title: 'Agent is stopped', state: 'blocked', status: 'The kill switch is on: nothing below can be used until you resume it.', action: { type: 'fund', label: 'Open dashboard', href: agentHref } });
  plan.push(balance > 0n
    ? { key: 'agent:funds', kind: 'agent', id: 'funds', title: 'Wallet funded', state: 'done', status: `${usd(balance)} available` }
    : { key: 'agent:funds', kind: 'agent', id: 'funds', title: 'Fund the wallet', state: 'todo', status: 'The agent has no money to spend yet.', action: { type: 'fund', label: 'Add funds with PayPal', href: agentHref } });
  if (d.agency) {
    const cur = await d.agency.current(agentId);
    const diff = await d.agency.changedSinceSigned(agent.ownerId, agentId).catch(() => ({ changed: true }));
    plan.push(cur.active && !diff.changed
      ? { key: 'agent:poa', kind: 'agent', id: 'poa', title: 'Power of Agency signed', state: 'done', status: `v${cur.active.version} covers everything the agent can do now` }
      : { key: 'agent:poa', kind: 'agent', id: 'poa', title: cur.active ? 'Re-sign the Power of Agency' : 'Sign the Power of Agency', state: 'todo',
          status: cur.active ? 'The agent’s access changed since you signed; sign the new terms so the contract matches.' : 'The contract that says what this agent may do for you.', action: { type: 'sign', label: cur.active ? 'Review & re-sign' : 'Review & sign' } });
  }
  const selPlatforms = items.filter((i) => i.kind === 'platform');
  plan.push(conns.length
    ? { key: 'agent:assistant', kind: 'agent', id: 'assistant', title: 'Assistant connected', state: 'done', status: connNames(conns) }
    : { key: 'agent:assistant', kind: 'agent', id: 'assistant', title: 'Connect the assistant that will use these', state: 'todo',
        status: 'Your agent reaches the marketplace through an assistant (Claude, ChatGPT, Grok…) or the dashboard.', action: { type: 'connect', label: 'Connect an assistant', platform: selPlatforms[0]?.id } });
  const need = needsFor(items);
  const gaps = conns.map((c) => ({
    id: c.id, label: c.label,
    addScopes: need.scopes.filter((s) => !c.scopes.includes(s)),
    addServices: need.services.filter((s) => !serviceAllowed(c.allowedServices, s)),
  })).filter((g) => g.addScopes.length || g.addServices.length);
  if (conns.length && (need.scopes.length || need.services.length)) {
    plan.push(gaps.length
      ? { key: 'agent:access', kind: 'agent', id: 'access', title: 'Give your assistant access to these selections', state: 'todo',
          status: gaps.map((g) => `${g.label}: ${[...g.addScopes.map((s) => `+${s}`), ...g.addServices.map((s) => `+${s}`)].join(' ')}`).join(' · '),
          action: { type: 'extend', label: gaps.length === 1 ? `Update ${gaps[0].label}` : `Update ${gaps.length} connections`, connections: gaps } }
      : { key: 'agent:access', kind: 'agent', id: 'access', title: 'Selections reach your assistant', state: 'done', status: 'Every connection may use every selected item, within its spending limits.' });
  }

  // ---- per selection ------------------------------------------------------
  for (const i of items) {
    if (i.kind === 'platform') {
      const p = findPlatform(i.id);
      const c = conns.find((x) => x.provider === p?.providerId);
      plan.push(c
        ? { key: `platform:${i.id}`, kind: 'platform', id: i.id, title: p?.name ?? i.id, state: 'done', status: c.lastUsedAt ? `Connected · last used ${c.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Connected · waiting for its first call',
            howTo: { prompt: 'Ask it: “What is my PayPali balance and what may I spend on?”', tools: ['get_agent_context', 'get_balance'] } }
        : { key: `platform:${i.id}`, kind: 'platform', id: i.id, title: p?.name ?? i.id, state: 'todo', status: 'Not connected yet.', action: { type: 'connect', label: `Connect ${p?.name ?? i.id}`, platform: i.id } });
    } else if (i.kind === 'service') {
      const s = findService(i.id);
      const orders = svcOrders.filter((o) => o.serviceId === i.id);
      const portal = d.portalStatus?.(i.id) ?? s?.portal.status ?? 'placeholder';
      const howTo = { prompt: `Ask your assistant: “Get a Gas quote for ${s?.actions[0]?.name ?? 'an action'} on ${s?.name ?? i.id}, then pay it if it’s within my limits.”`, tools: ['search_services', 'estimate_gas', 'pay_with_gas', 'get_order'], http: `POST /api/agents/${agentId}/gas/estimate → /gas/pay` };
      const base = { key: `service:${i.id}`, kind: 'service' as const, id: i.id, title: s?.name ?? i.id, howTo };
      if (!has('market.service')) plan.push({ ...base, state: 'todo', status: 'The agent isn’t allowed to pay for services yet.', action: { type: 'grant', label: 'Allow paying for services', capability: 'market.service' } });
      else if (portal === 'placeholder') plan.push({ ...base, state: 'blocked', status: 'Placeholder portal: the agent can get quotes, but payment is refused until the company connects an Agent Portal.', action: { type: 'open', label: 'Get a quote', item: `service:${i.id}` } });
      else plan.push({ ...base, state: orders.length ? 'done' : 'todo', status: orders.length ? `${orders.length} order${orders.length === 1 ? '' : 's'} · last ${orders[0].status.toLowerCase()}${portal === 'sandbox' ? ' (sandbox portal)' : ''}` : `Ready${portal === 'sandbox' ? ' (sandbox portal: simulated provider, real ledger)' : ''}. Nothing bought yet.`, action: { type: 'open', label: orders.length ? 'Buy again' : 'Try it now', item: `service:${i.id}` } });
    } else if (i.kind === 'bazaar') {
      const l = listings.find((x: any) => x.id === i.id);
      const orders = (bz?.orders ?? []).filter((o: any) => o.solutionId === i.id);
      const paid = orders.find((o: any) => o.status === 'PAID' && o.receiptId);
      const howTo = { prompt: `Ask your assistant: “Buy ${l?.name ?? i.id} on AgentBazaar, run it, and report whether it worked.”`, tools: ['bazaar_search', 'bazaar_buy', 'bazaar_run', 'bazaar_report'], http: `POST /api/agents/${agentId}/bazaar/buy → /bazaar/run → /bazaar/report` };
      const base = { key: `bazaar:${i.id}`, kind: 'bazaar' as const, id: i.id, title: l?.name ?? i.id, howTo };
      if (!d.bazaar) plan.push({ ...base, state: 'blocked', status: 'AgentBazaar isn’t connected to this PayPali (run npm run stack).' });
      else if (!bz?.account?.enabled) plan.push({ ...base, state: 'todo', status: bz?.account?.disabledByOwner ? 'You turned AgentBazaar off for this agent.' : 'AgentBazaar isn’t enabled for this agent yet.', action: { type: 'enable_bazaar', label: 'Enable AgentBazaar ($200 budget)' } });
      else if (paid) {
        const waiting = pending.filter((r) => r.solution_id === i.id).length;
        plan.push(waiting
          ? { ...base, state: 'todo', status: `Your agent ran it and reported a result. Confirm what you saw: that settles its Score stake and builds the seller’s track record.`, action: { type: 'attest', label: waiting > 1 ? `Confirm ${waiting} results` : 'Confirm the result', item: `bazaar:${i.id}`, runs: waiting } }
          : { ...base, state: 'done', status: `Bought · receipt ${String(paid.receiptId).slice(0, 10)}… · runs whenever your agent needs it`, action: { type: 'open', label: 'Run it', item: `bazaar:${i.id}` } });
      }
      else plan.push({ ...base, state: 'todo', status: `${l ? `V${l.tier} · ${usd(l.priceMinor)} for ${l.runsIncluded} runs. ` : ''}Not bought yet.`, action: { type: 'open', label: 'Buy it', item: `bazaar:${i.id}` } });
    } else if (i.kind === 'data') {
      const a = dataAgents.find((x) => x.slug === i.id);
      const sub = a ? subs.find((x) => x.dataAgentId === a.id) : null;
      const qs = a ? queries.filter((q) => q.dataAgentId === a.id) : [];
      const answered = qs.filter((q) => q.status === 'ANSWERED' || q.status === 'SETTLED').length;
      const howTo = { prompt: `Ask your assistant: “Ask ${a?.name ?? i.id} a question for my objective and tell me what it cost.”`, tools: ['data_agents', 'data_quote', 'data_query', 'data_subscribe'], http: `POST /api/agents/${agentId}/data/query` };
      const base = { key: `data:${i.id}`, kind: 'data' as const, id: i.id, title: a?.name ?? i.id, howTo };
      if (!a) plan.push({ ...base, state: 'blocked', status: 'This data agent is no longer listed.' });
      else if (!has('data.query')) plan.push({ ...base, state: 'todo', status: 'The agent isn’t allowed to buy answers yet.', action: { type: 'grant', label: 'Allow buying answers', capability: 'data.query' } });
      else plan.push({ ...base, state: answered ? 'done' : 'todo', status: `${answered} answer${answered === 1 ? '' : 's'} bought${sub ? ` · subscribed ${usd(sub.monthlyBudgetMinor)}/month` : ''}${a.status !== 'ACTIVE' ? ' · listing paused' : ''}`, action: { type: 'open', label: answered ? 'Ask another question' : 'Ask a question', item: `data:${i.id}` } });
    } else if (i.kind === 'skill') {
      const s = await d.prisma.skill.findUnique({ where: { slug: i.id }, include: { offers: true } });
      const seller = s ? await d.prisma.agent.findUnique({ where: { id: s.agentId } }) : null;
      const lic = s ? await d.prisma.license.findFirst({ where: { licenseeAgentId: agentId, skillId: s.id, status: 'ACTIVE' } }) : null;
      const calls = lic ? await d.prisma.skillCall.count({ where: { licenseId: lic.id, status: 'SETTLED' } }) : 0;
      const howTo = { prompt: `Ask your assistant: “Use the ${s?.name ?? i.id} skill for my objective and tell me what it cost in Gas.”`, tools: ['skills_search', 'skill_quote', 'skill_license', 'skill_invoke'], http: `POST /api/agents/${agentId}/skills/invoke` };
      const base = { key: `skill:${i.id}`, kind: 'skill' as const, id: i.id, title: s?.name ?? i.id, howTo };
      const perCall = s?.offers.find((o) => o.active && o.mode === 'PER_CALL');
      if (!s || s.status !== 'ACTIVE') plan.push({ ...base, state: 'blocked', status: 'This skill is not on sale right now.' });
      else if (!seller?.isActive) plan.push({ ...base, state: 'blocked', status: `${seller?.name ?? 'Its agent'} is stopped, so the skill isn’t selling.` });
      else if (!lic) plan.push({ ...base, state: 'todo', status: `Sold by ${seller.name}${perCall ? ` · ${perCall.priceGas} Gas per call` : ''}. Not licensed yet.`, action: { type: 'open', label: 'License it', item: `skill:${i.id}` } });
      else plan.push({ ...base, state: 'done', status: `Licensed from ${seller.name} (${lic.mode.toLowerCase().replace('_', ' ')})${calls ? ` · used ${calls} time${calls === 1 ? '' : 's'}` : ''}`, action: { type: 'open', label: 'Use it', item: `skill:${i.id}` } });
    }
  }
  const counted = plan.filter((p) => p.state !== 'blocked');
  return { agentId, ready: counted.filter((p) => p.state === 'done').length, total: counted.length, items: plan };
}

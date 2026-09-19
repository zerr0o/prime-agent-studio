// Native agent envelopes are presentation data, never instructions for the Studio.
const clean = (value, limit = 240) => (typeof value === 'string' ? value.slice(0, limit) : '');
export function parseAgentEnvelope(text) {
  if (typeof text !== 'string') return null;
  const current = /^\[agent-message from (?:(child|sibling|parent):)?([^\]\r\n]+)\]\r?\n\r?\n([\s\S]*)$/.exec(
    text,
  );
  if (current)
    return {
      relationship: current[1] || '',
      name: clean(current[2]),
      sender: '',
      target: '',
      id: '',
      text: current[3],
    };
  const match =
    /^(?:\[from (child|sibling|parent)(?::([^\]\n]+))?\]\r?\n)?Agent-to-agent message received\.\r?\nSource: agent_message\r?\n(?:From: ([^\r\n]+)\r?\n)?To: ([^\r\n]+)\r?\nMessage id: (agentmsg_[^\r\n]+)\r?\n\r?\n([\s\S]*)$/.exec(
      text,
    );
  if (!match) return null;
  return {
    relationship: match[1] || '',
    name: clean(match[2] || match[3]?.split(', active ')[0]),
    sender: clean(match[3]),
    target: clean(match[4]),
    id: clean(match[5]),
    text: match[6],
  };
}
export function nativeAgentMessage(message) {
  if (message?.customType !== 'agent_message') return null;
  const details = message.details;
  if (typeof details?.message === 'string' && typeof details?.id === 'string') {
    return {
      id: clean(details.id),
      text: details.message,
      name: clean(details.from?.sessionName || details.from?.sessionId || details.from?.activeSessionId),
      relationship: ['child', 'sibling', 'parent'].includes(details.fromRelationship)
        ? details.fromRelationship
        : '',
      sender: clean(details.from?.sessionId || details.from?.activeSessionId),
      target: clean(details.target?.sessionId || details.target?.activeSessionId),
    };
  }
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
  return parseAgentEnvelope(text);
}
export function queuedAgentMessage(text) {
  const envelope = parseAgentEnvelope(text);
  if (envelope) return envelope;
  // Prime Agent's queue API returns previews, without sender metadata.
  if (typeof text === 'string' && text.startsWith('Agent message received: '))
    return { name: '', relationship: '', text: text.slice('Agent message received: '.length) };
  return null;
}

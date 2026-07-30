export async function readSseJson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let event: any;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      onEvent(event);
    }
    if (done) break;
  }
}

export default function studioImages(pi) {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nStudio can display existing project images inline. Use Markdown ![caption](project-relative/path.png) for PNG, JPEG, GIF or WebP files that exist inside the current project. Do not embed base64 or use localhost/file URLs. The image is read from its original location, not archived; removed files display an unavailable placeholder.`,
  }));
  // 0.9.6 stamps routed assistant messages with the serving vision model.
  // Native resume (and Studio history) would then select that model instead
  // of the configured text model. Append native provenance after persistence,
  // including retries, without rewriting the assistant or changing defaults.
  pi.on('agent_end', (_event, ctx) => {
    const model = ctx.model;
    if (!model?.input || model.input.includes('image')) return;
    const manager = ctx.sessionManager;
    const lastModel = manager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === 'model_change' || (entry.type === 'message' && entry.message?.role === 'assistant'),
      );
    if (lastModel?.type !== 'message') return;
    const served = lastModel.message;
    if (served.provider === model.provider && served.model === model.id) return;
    if (!ctx.modelRegistry.find(served.provider, served.model)?.input.includes('image')) return;
    if (typeof manager.appendModelChange !== 'function')
      throw new Error('Prime Agent image routing persistence adapter requires an update.');
    manager.appendModelChange(model.provider, model.id);
  });
}

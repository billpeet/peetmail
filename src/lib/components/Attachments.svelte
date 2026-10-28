<script lang="ts">
  import { api, type Attachment } from "#lib/api.js";
  import { mail } from "#lib/mail.svelte.js";

  let { messageId }: { messageId: number } = $props();

  let items = $state<Attachment[] | null>(null);

  $effect(() => {
    const id = messageId;
    items = null;
    api.listAttachments(id).then(
      (a) => id === messageId && (items = a),
      () => id === messageId && (items = []),
    );
  });

  function size(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function download(a: Attachment) {
    try {
      const path = await api.downloadAttachment(messageId, a.id, a.name);
      mail.showToast({ text: `Saved ${path.split(/[\\/]/).pop()}` });
    } catch (e) {
      mail.showToast({ text: String(e), error: true });
    }
  }
</script>

{#if items?.length}
  <div data-testid="attachments" class="flex flex-wrap gap-2 px-2 pb-2">
    {#each items as a (a.id)}
      <button
        data-testid="attachment"
        onclick={() => download(a)}
        title="Save to Downloads"
        class="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs text-ink-300 hover:border-ink-500 hover:text-ink-100"
      >
        <span>{a.name}</span>
        <span class="text-ink-500">{size(a.size)}</span>
      </button>
    {/each}
  </div>
{/if}

import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { competitorKey, timelineKey } from '../../lib/queries';
import { ErrorNotice } from '../../components/Feedback';

export function RemoveCompetitor({
  id,
  close,
  removed,
}: {
  id: string;
  close: () => void;
  removed: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.removeCompetitor(id),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: competitorKey }),
        client.invalidateQueries({ queryKey: timelineKey(id) }),
      ]);
      removed(id);
      close();
    },
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="remove-title"
      aria-describedby="remove-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!mutation.isPending) close();
      }}
    >
      <h2 id="remove-title">Stop tracking this competitor?</h2>
      <p id="remove-description">
        <strong>{id}</strong> will leave your watchlist. Its saved history is kept, and you can
        track it again at any time.
      </p>
      {mutation.error && <ErrorNotice error={mutation.error} />}
      <div className="dialog-actions">
        <button
          className="button button--ghost"
          autoFocus
          onClick={close}
          disabled={mutation.isPending}
        >
          Keep tracking
        </button>
        <button
          className="button button--danger"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? 'Stopping…' : 'Stop tracking'}
        </button>
      </div>
    </dialog>
  );
}

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createCompetitorSchema } from '@rounds/shared';
import { api } from '../../api';
import { competitorKey } from '../../lib/queries';
import { ErrorNotice } from '../../components/Feedback';
import { Icon } from '../../components/Icon';

export function AddCompetitor() {
  const [id, setId] = useState('');
  const [validation, setValidation] = useState('');
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: api.addCompetitor,
    onSuccess: async (result) => {
      setId('');
      setNotice(
        result.created
          ? `${result.id} is now tracked. The first poll is queued.`
          : `${result.id} is already on your watchlist.`,
      );
      await client.invalidateQueries({ queryKey: competitorKey });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    const result = createCompetitorSchema.safeParse({ id });
    setNotice('');
    mutation.reset();
    if (!result.success) {
      setValidation(
        'Enter an ID of 1–128 characters. Start with a letter or number; use only letters, numbers, hyphens and underscores.',
      );
      return;
    }
    setValidation('');
    mutation.mutate(result.data);
  }
  return (
    <section className="add-panel" aria-labelledby="add-heading">
      <div>
        <h2 id="add-heading">Add a competitor</h2>
        <p>Enter its listing ID to start watching for changes.</p>
      </div>
      <form onSubmit={submit} noValidate>
        <label className="sr-only" htmlFor="competitor-id">
          Competitor ID
        </label>
        <div className="add-input-row">
          <input
            id="competitor-id"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. acme-crm"
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              if (validation) setValidation('');
              if (mutation.isError) mutation.reset();
            }}
            disabled={mutation.isPending}
            aria-invalid={!!validation}
            aria-describedby={validation ? 'id-error id-help' : 'id-help'}
          />
          <button className="button button--primary" disabled={mutation.isPending} type="submit">
            <Icon name="plus" />
            {mutation.isPending ? 'Adding…' : 'Track competitor'}
          </button>
        </div>
        <p id="id-help" className="field-help">
          IDs are case-sensitive. Unknown IDs are saved and checked by the source.
        </p>
        {validation && (
          <p id="id-error" className="field-error" role="alert">
            {validation}
          </p>
        )}
        {mutation.error && <ErrorNotice error={mutation.error} />}
        <p className="form-notice" role="status">
          {notice}
        </p>
      </form>
    </section>
  );
}

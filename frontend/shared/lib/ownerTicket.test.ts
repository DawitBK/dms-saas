import { describe, expect, it } from 'vitest';
import { OWNER_AUTHORISATION_HEADER, ownerTicketHeaders } from './ownerTicket';

describe('ownerTicketHeaders', () => {
  it('sends nothing for an empty or blank paste', () => {
    expect(ownerTicketHeaders('')).toEqual({});
    expect(ownerTicketHeaders('  \n\t ')).toEqual({});
  });

  it('puts the ticket in X-Owner-Authorisation', () => {
    expect(ownerTicketHeaders('aaa.bbb.ccc')).toEqual({ [OWNER_AUTHORISATION_HEADER]: 'aaa.bbb.ccc' });
  });

  it('strips surrounding whitespace and pasted line breaks', () => {
    expect(ownerTicketHeaders('  aaa.bbb\r\n.ccc \n')).toEqual({ [OWNER_AUTHORISATION_HEADER]: 'aaa.bbb.ccc' });
  });
});

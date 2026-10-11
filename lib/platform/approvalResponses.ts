import { NextResponse } from 'next/server';

/**
 * The two non-success answers a capability gate can give, in one place so
 * every gated route says the same thing and the client can branch on `code`
 * rather than on prose.
 *
 * These are deliberately NOT errors in the 4xx-because-you-did-something-wrong
 * sense — the employee did hold the permission and asked correctly. 202 says
 * "accepted, not yet carried out", which is exactly the state of a held
 * request.
 */

/** 202 — parked. Nothing happened; the approving manager has been notified. */
export function heldResponse(requestId: string): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      code: 'pending_approval',
      pendingApproval: true,
      requestId,
      message: 'Sent to your approving manager. It will happen once they approve it.',
      messageAr: 'أُرسل إلى المدير المعتمد. سيتم التنفيذ بعد موافقته.',
    },
    { status: 202 }
  );
}

/**
 * 409 — the permission was handed out as "requires approval", but no approving
 * manager is assigned, so nobody can say yes. Refused: resolving a missing
 * assignment permissively would silently turn the gate off.
 */
export function noApproverResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: 'no_approver',
      error:
        'This action needs a manager’s approval, but no approving manager has been assigned. Ask an admin to set one in Settings.',
      errorAr:
        'يتطلب هذا الإجراء موافقة مدير، ولم يُعيَّن مدير معتمد بعد. اطلب من المسؤول تعيين واحد في الإعدادات.',
    },
    { status: 409 }
  );
}

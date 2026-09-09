// Shared shapes for Server Action results.
//
// Error shape matches Phase 4-J rule 5: a machine-readable `code` +
// human-readable `message`, never a raw stack trace to the client.
export type ActionError = {
  code: string;
  message: string;
};

export type ActionState = {
  error?: ActionError;
  success?: boolean;
};

export const initialActionState: ActionState = {};

export function actionError(code: string, message: string): ActionState {
  return { error: { code, message } };
}

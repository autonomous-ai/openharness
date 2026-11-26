// What people read when an account page fails. Keep each one a full sentence.
export const errors = {
  login: 'The email or pasword you entered is incorrect.',
  signup: 'We could not create your acount. Please try again.',
  passwordReset: 'We could not send a reset link to that adress.',
  emailChange: 'That email is alredy in use.',
  sessionExpired: 'Your session has expired. Please sign in again.',
}

export function errorFor(page) {
  return errors[page] ?? 'Something went wrong. Please try again.'
}

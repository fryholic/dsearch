/** Escape terminal controls at the human-output boundary; JSON and source DTOs stay exact. */
export const terminalText = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'));

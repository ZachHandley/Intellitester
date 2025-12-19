import type { EmailClientConfig, EmailHeader, Email } from "./types";

export class InbucketClient {
  private endpoint: string;

  constructor(config: EmailClientConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, ""); // Remove trailing slash
  }

  /**
   * Extract mailbox name from email (e.g., "test@example.com" → "test")
   */
  private getMailboxName(email: string): string {
    return email.split("@")[0];
  }

  /**
   * List all messages in a mailbox
   */
  async listMessages(email: string): Promise<EmailHeader[]> {
    const mailbox = this.getMailboxName(email);
    const url = `${this.endpoint}/api/v1/mailbox/${mailbox}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to list messages for ${email}: ${response.status} ${response.statusText}`,
      );
    }

    const messages = (await response.json()) as EmailHeader[];
    return messages;
  }

  /**
   * Get a specific message
   */
  async getMessage(email: string, id: string): Promise<Email> {
    const mailbox = this.getMailboxName(email);
    const url = `${this.endpoint}/api/v1/mailbox/${mailbox}/${id}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to get message ${id} for ${email}: ${response.status} ${response.statusText}`,
      );
    }

    const message = (await response.json()) as Email;
    return message;
  }

  /**
   * Wait for an email to arrive (polling with timeout)
   */
  async waitForEmail(
    email: string,
    options?: {
      timeout?: number; // default 30000ms
      pollInterval?: number; // default 1000ms
      subjectContains?: string;
    },
  ): Promise<Email> {
    const timeout = options?.timeout ?? 30000;
    const pollInterval = options?.pollInterval ?? 1000;
    const subjectContains = options?.subjectContains;

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const messages = await this.listMessages(email);

      // Find matching message
      const matchingMessage = messages.find((msg) => {
        if (subjectContains) {
          return msg.subject.includes(subjectContains);
        }
        return true; // Return first message if no subject filter
      });

      if (matchingMessage) {
        // Get the full message
        return await this.getMessage(email, matchingMessage.id);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `Timeout waiting for email to ${email}${subjectContains ? ` with subject containing "${subjectContains}"` : ""}`,
    );
  }

  /**
   * Extract verification code from email body
   */
  extractCode(email: Email, pattern?: RegExp): string | null {
    // Default pattern: 6-digit code
    const regex = pattern ?? /\b(\d{6})\b/;
    const text = email.body.text || email.body.html;
    const match = text.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Extract link from email body
   */
  extractLink(email: Email, pattern?: RegExp): string | null {
    // Default: any http/https URL
    const regex = pattern ?? /https?:\/\/[^\s"'<>]+/;
    const text = email.body.text || email.body.html;
    const match = text.match(regex);
    return match ? match[0] : null;
  }

  /**
   * Delete a specific message
   */
  async deleteMessage(email: string, id: string): Promise<void> {
    const mailbox = this.getMailboxName(email);
    const url = `${this.endpoint}/api/v1/mailbox/${mailbox}/${id}`;

    const response = await fetch(url, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(
        `Failed to delete message ${id} for ${email}: ${response.status} ${response.statusText}`,
      );
    }
  }

  /**
   * Clear all messages in a mailbox
   */
  async clearMailbox(email: string): Promise<void> {
    const mailbox = this.getMailboxName(email);
    const url = `${this.endpoint}/api/v1/mailbox/${mailbox}`;

    const response = await fetch(url, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(
        `Failed to clear mailbox for ${email}: ${response.status} ${response.statusText}`,
      );
    }
  }
}

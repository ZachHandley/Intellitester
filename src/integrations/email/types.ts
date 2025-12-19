export interface EmailHeader {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  size: number;
}

export interface Email {
  mailbox: string;
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  body: {
    text: string;
    html: string;
  };
}

export interface EmailClientConfig {
  endpoint: string; // e.g., http://localhost:9000
}

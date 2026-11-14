/** A conversation's id is its log file's stem (`20261114-172146-c1`); the address holds one only when it has that shape. */
export const CONVERSATION_ID = /^\d{8}-\d{6}-[A-Za-z0-9_-]{1,64}$/;

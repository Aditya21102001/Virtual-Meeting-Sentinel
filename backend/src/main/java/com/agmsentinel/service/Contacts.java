package com.agmsentinel.service;

/** Normalize email/phone so registration and OTP-login match regardless of formatting. */
final class Contacts {
    private Contacts() { }

    static String email(String raw) {
        return raw == null ? null : raw.trim().toLowerCase();
    }

    /** Keep a leading '+' and digits only, so "+91 90000-00000" == "+919000000000". */
    static String phone(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        boolean plus = trimmed.startsWith("+");
        String digits = trimmed.replaceAll("[^0-9]", "");
        return plus ? "+" + digits : digits;
    }
}

package com.agmsentinel.security;

import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.repository.WebAuthnCredentialRepository;
import com.yubico.webauthn.CredentialRepository;
import com.yubico.webauthn.RegisteredCredential;
import com.yubico.webauthn.data.ByteArray;
import com.yubico.webauthn.data.PublicKeyCredentialDescriptor;
import org.springframework.stereotype.Component;

import java.nio.ByteBuffer;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Bridges the Yubico WebAuthn library to our JPA tables. The "user handle" is the user's
 * UUID encoded as 16 bytes; credential ids and public keys are stored base64url.
 */
@Component
public class JpaCredentialRepository implements CredentialRepository {

    private final AppUserRepository users;
    private final WebAuthnCredentialRepository creds;

    public JpaCredentialRepository(AppUserRepository users, WebAuthnCredentialRepository creds) {
        this.users = users;
        this.creds = creds;
    }

    public static ByteArray uuidToHandle(UUID id) {
        ByteBuffer bb = ByteBuffer.allocate(16);
        bb.putLong(id.getMostSignificantBits());
        bb.putLong(id.getLeastSignificantBits());
        return new ByteArray(bb.array());
    }

    public static UUID handleToUuid(ByteArray handle) {
        ByteBuffer bb = ByteBuffer.wrap(handle.getBytes());
        return new UUID(bb.getLong(), bb.getLong());
    }

    @Override
    public Set<PublicKeyCredentialDescriptor> getCredentialIdsForUsername(String username) {
        return users.findByUsername(username)
                .map(creds::findByUser).orElseGet(List::of).stream()
                .map(c -> PublicKeyCredentialDescriptor.builder()
                        .id(fromB64(c.getCredentialId())).build())
                .collect(Collectors.toSet());
    }

    @Override
    public Optional<ByteArray> getUserHandleForUsername(String username) {
        return users.findByUsername(username).map(u -> uuidToHandle(u.getId()));
    }

    @Override
    public Optional<String> getUsernameForUserHandle(ByteArray userHandle) {
        return users.findById(handleToUuid(userHandle)).map(AppUser::getUsername);
    }

    @Override
    public Optional<RegisteredCredential> lookup(ByteArray credentialId, ByteArray userHandle) {
        return creds.findByCredentialId(credentialId.getBase64Url()).map(c -> RegisteredCredential.builder()
                .credentialId(credentialId)
                .userHandle(uuidToHandle(c.getUser().getId()))
                .publicKeyCose(fromB64(c.getPublicKeyCose()))
                .signatureCount(c.getSignCount())
                .build());
    }

    @Override
    public Set<RegisteredCredential> lookupAll(ByteArray credentialId) {
        return creds.findByCredentialId(credentialId.getBase64Url())
                .map(c -> Set.of(RegisteredCredential.builder()
                        .credentialId(credentialId)
                        .userHandle(uuidToHandle(c.getUser().getId()))
                        .publicKeyCose(fromB64(c.getPublicKeyCose()))
                        .signatureCount(c.getSignCount())
                        .build()))
                .orElseGet(Set::of);
    }

    private static ByteArray fromB64(String b64url) {
        try {
            return ByteArray.fromBase64Url(b64url);
        } catch (Exception e) {
            throw new IllegalStateException("Corrupt stored credential", e);
        }
    }
}

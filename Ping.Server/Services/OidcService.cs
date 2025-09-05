using Microsoft.EntityFrameworkCore;
using Ping.Server.Data;
using Ping.Server.Models;
using System.Security.Cryptography;

namespace Ping.Server.Services
{
    public interface IOidcService
    {
        Task<VerificationCode> CreateVerificationCodeAsync(string email);
        Task<ApplicationUser?> ValidateVerificationCodeAsync(string email, string code);
        Task<ApplicationUser> GetOrCreateUserAsync(string email, string? name = null);
        
        // Legacy methods for backward compatibility
        Task<MagicLinkToken> CreateMagicLinkAsync(string email);
        Task<ApplicationUser?> ValidateMagicLinkAsync(string token);
    }

    public class OidcService : IOidcService
    {
        private readonly ApplicationDbContext _context;
        private readonly IUserService _userService;
        private readonly ILogger<OidcService> _logger;

        public OidcService(ApplicationDbContext context, IUserService userService, ILogger<OidcService> logger)
        {
            _context = context;
            _userService = userService;
            _logger = logger;
        }

        public async Task<VerificationCode> CreateVerificationCodeAsync(string email)
        {
            // Check if user is registered and allowed to sign in
            var isRegistered = await _userService.IsUserRegisteredAsync(email);
            if (!isRegistered)
            {
                _logger.LogWarning("Verification code requested for unregistered email: {Email}", email);
                throw new UnauthorizedAccessException("Email not registered for this service");
            }

            // Clean up expired codes
            var expiredCodes = await _context.VerificationCodes
                .Where(c => c.ExpiresAt < DateTime.UtcNow)
                .ToListAsync();
            _context.VerificationCodes.RemoveRange(expiredCodes);

            // Invalidate any existing unused codes for this email
            var existingCodes = await _context.VerificationCodes
                .Where(c => c.Email == email.ToLowerInvariant() && !c.IsUsed && c.ExpiresAt > DateTime.UtcNow)
                .ToListAsync();
            
            foreach (var existingCode in existingCodes)
            {
                existingCode.IsUsed = true;
            }

            // Generate 6-digit code
            var code = GenerateSixDigitCode();

            var verificationCode = new VerificationCode
            {
                Email = email.ToLowerInvariant(),
                Code = code,
                ExpiresAt = DateTime.UtcNow.AddMinutes(10)
            };

            _context.VerificationCodes.Add(verificationCode);
            await _context.SaveChangesAsync();

            _logger.LogInformation("Created verification code for registered email: {Email}", email);
            return verificationCode;
        }

        public async Task<ApplicationUser?> ValidateVerificationCodeAsync(string email, string code)
        {
            var normalizedEmail = email.ToLowerInvariant();
            
            // First check if user is registered
            var user = await _userService.GetUserByEmailAsync(normalizedEmail);
            if (user == null)
            {
                _logger.LogWarning("Verification code validation attempted for unregistered email: {Email}", email);
                return null;
            }

            var verificationCode = await _context.VerificationCodes
                .FirstOrDefaultAsync(c => 
                    c.Email == normalizedEmail && 
                    c.Code == code && 
                    !c.IsUsed && 
                    c.ExpiresAt > DateTime.UtcNow);

            if (verificationCode == null)
            {
                // Track failed attempts
                var anyCodeForEmail = await _context.VerificationCodes
                    .Where(c => c.Email == normalizedEmail && c.ExpiresAt > DateTime.UtcNow)
                    .OrderByDescending(c => c.CreatedAt)
                    .FirstOrDefaultAsync();

                if (anyCodeForEmail != null)
                {
                    anyCodeForEmail.AttemptCount++;
                    await _context.SaveChangesAsync();
                    
                    if (anyCodeForEmail.AttemptCount >= 5)
                    {
                        anyCodeForEmail.IsUsed = true;
                        await _context.SaveChangesAsync();
                        _logger.LogWarning("Too many attempts for verification code, email: {Email}", email);
                    }
                }

                _logger.LogWarning("Invalid verification code for email: {Email}, code: {Code}", email, code);
                return null;
            }

            // Mark code as used
            verificationCode.IsUsed = true;
            user.LastSignInAt = DateTime.UtcNow;

            await _context.SaveChangesAsync();

            _logger.LogInformation("Verification code validated for user: {Email}", user.Email);
            return user;
        }

        public async Task<ApplicationUser> GetOrCreateUserAsync(string email, string? name = null)
        {
            // This method should only return existing registered users
            var user = await _userService.GetUserByEmailAsync(email);
            if (user == null)
            {
                throw new UnauthorizedAccessException("User not registered for this service");
            }
            return user;
        }

        private static string GenerateSixDigitCode()
        {
            using var rng = RandomNumberGenerator.Create();
            var bytes = new byte[4];
            rng.GetBytes(bytes);
            var randomNumber = Math.Abs(BitConverter.ToInt32(bytes, 0));
            return (randomNumber % 1000000).ToString("D6");
        }

        // Legacy methods for backward compatibility
        public async Task<MagicLinkToken> CreateMagicLinkAsync(string email)
        {
            var isRegistered = await _userService.IsUserRegisteredAsync(email);
            if (!isRegistered)
            {
                throw new UnauthorizedAccessException("Email not registered for this service");
            }

            var expiredTokens = await _context.MagicLinkTokens
                .Where(t => t.ExpiresAt < DateTime.UtcNow)
                .ToListAsync();
            _context.MagicLinkTokens.RemoveRange(expiredTokens);

            var tokenBytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(tokenBytes);
            }
            var token = Convert.ToBase64String(tokenBytes)
                .Replace('+', '-')
                .Replace('/', '_')
                .TrimEnd('=');

            var magicLinkToken = new MagicLinkToken
            {
                Email = email.ToLowerInvariant(),
                Token = token,
                ExpiresAt = DateTime.UtcNow.AddMinutes(15)
            };

            _context.MagicLinkTokens.Add(magicLinkToken);
            await _context.SaveChangesAsync();

            _logger.LogInformation("Created magic link token for registered email: {Email}", email);
            return magicLinkToken;
        }

        public async Task<ApplicationUser?> ValidateMagicLinkAsync(string token)
        {
            var magicLinkToken = await _context.MagicLinkTokens
                .FirstOrDefaultAsync(t => t.Token == token && !t.IsUsed && t.ExpiresAt > DateTime.UtcNow);

            if (magicLinkToken == null)
            {
                _logger.LogWarning("Invalid or expired magic link token: {Token}", token);
                return null;
            }

            var user = await _userService.GetUserByEmailAsync(magicLinkToken.Email);
            if (user == null)
            {
                _logger.LogWarning("Magic link token for unregistered email: {Email}", magicLinkToken.Email);
                return null;
            }

            magicLinkToken.IsUsed = true;
            user.LastSignInAt = DateTime.UtcNow;

            await _context.SaveChangesAsync();

            _logger.LogInformation("Magic link validated for user: {Email}", user.Email);
            return user;
        }
    }
}
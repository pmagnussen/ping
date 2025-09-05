using Microsoft.EntityFrameworkCore;
using Ping.Server.Data;
using Ping.Server.Models;

namespace Ping.Server.Services
{
    public interface IUserService
    {
        Task<ApplicationUser?> GetUserByEmailAsync(string email);
        Task<ApplicationUser?> GetUserByIdAsync(string userId);
        Task<ApplicationUser> CreateUserAsync(string email, string name, UserRole role = UserRole.User);
        Task<bool> IsUserRegisteredAsync(string email);
        Task<bool> HasPermissionAsync(string userId, string permission);
        Task<string[]> GetUserPermissionsAsync(string userId);
        Task GrantPermissionAsync(string userId, string permission, string grantedBy);
        Task RevokePermissionAsync(string userId, string permission);
        Task UpdateUserRoleAsync(string userId, UserRole role);
        Task<List<ApplicationUser>> GetAllUsersAsync();
        Task DeactivateUserAsync(string userId);
        Task ActivateUserAsync(string userId);
    }

    public class UserService : IUserService
    {
        private readonly ApplicationDbContext _context;
        private readonly ILogger<UserService> _logger;

        public UserService(ApplicationDbContext context, ILogger<UserService> logger)
        {
            _context = context;
            _logger = logger;
        }

        public async Task<ApplicationUser?> GetUserByEmailAsync(string email)
        {
            return await _context.Users
                .Include(u => u.UserPermissions)
                .FirstOrDefaultAsync(u => u.Email == email.ToLowerInvariant() && u.IsActive);
        }

        public async Task<ApplicationUser?> GetUserByIdAsync(string userId)
        {
            return await _context.Users
                .Include(u => u.UserPermissions)
                .FirstOrDefaultAsync(u => u.Id == userId && u.IsActive);
        }

        public async Task<ApplicationUser> CreateUserAsync(string email, string name, UserRole role = UserRole.User)
        {
            var normalizedEmail = email.ToLowerInvariant();

            var existingUser = await _context.Users.FirstOrDefaultAsync(u => u.Email == normalizedEmail);
            if (existingUser != null)
            {
                throw new InvalidOperationException($"User with email {email} already exists");
            }

            var user = new ApplicationUser
            {
                Email = normalizedEmail,
                Name = name,
                Role = role,
                Permissions = PingPermissions.RolePermissions[role].ToList()
            };

            _context.Users.Add(user);

            // Add individual permission records
            foreach (var permission in PingPermissions.RolePermissions[role])
            {
                _context.UserPermissions.Add(new UserPermission
                {
                    UserId = user.Id,
                    Permission = permission,
                    GrantedBy = "SYSTEM"
                });
            }

            await _context.SaveChangesAsync();
            _logger.LogInformation("Created user: {Email} with role: {Role}", email, role);

            return user;
        }

        public async Task<bool> IsUserRegisteredAsync(string email)
        {
            return await _context.Users.AnyAsync(u =>
                u.Email == email.ToLowerInvariant() && u.IsActive);
        }

        public async Task<bool> HasPermissionAsync(string userId, string permission)
        {
            var user = await GetUserByIdAsync(userId);
            if (user == null) return false;

            // Check both direct permissions and role-based permissions
            return user.Permissions.Contains(permission) ||
                   user.UserPermissions.Any(p => p.Permission == permission);
        }

        public async Task<string[]> GetUserPermissionsAsync(string userId)
        {
            var user = await GetUserByIdAsync(userId);
            if (user == null) return Array.Empty<string>();

            // Combine direct permissions and granted permissions
            var allPermissions = user.Permissions
                .Concat(user.UserPermissions.Select(p => p.Permission))
                .Distinct()
                .ToArray();

            return allPermissions;
        }

        public async Task GrantPermissionAsync(string userId, string permission, string grantedBy)
        {
            var user = await GetUserByIdAsync(userId);
            if (user == null) throw new ArgumentException("User not found");

            if (!user.Permissions.Contains(permission))
            {
                user.Permissions.Add(permission);
            }

            var existingPermission = await _context.UserPermissions
                .FirstOrDefaultAsync(p => p.UserId == userId && p.Permission == permission);

            if (existingPermission == null)
            {
                _context.UserPermissions.Add(new UserPermission
                {
                    UserId = userId,
                    Permission = permission,
                    GrantedBy = grantedBy
                });
            }

            await _context.SaveChangesAsync();
            _logger.LogInformation("Granted permission {Permission} to user {UserId}", permission, userId);
        }

        public async Task RevokePermissionAsync(string userId, string permission)
        {
            var user = await GetUserByIdAsync(userId);
            if (user == null) return;

            user.Permissions.Remove(permission);

            var permissionRecord = await _context.UserPermissions
                .FirstOrDefaultAsync(p => p.UserId == userId && p.Permission == permission);

            if (permissionRecord != null)
            {
                _context.UserPermissions.Remove(permissionRecord);
            }

            await _context.SaveChangesAsync();
            _logger.LogInformation("Revoked permission {Permission} from user {UserId}", permission, userId);
        }

        public async Task UpdateUserRoleAsync(string userId, UserRole role)
        {
            var user = await GetUserByIdAsync(userId);
            if (user == null) throw new ArgumentException("User not found");

            user.Role = role;
            user.Permissions = PingPermissions.RolePermissions[role].ToList();

            // Remove existing permissions and add role-based ones
            var existingPermissions = _context.UserPermissions.Where(p => p.UserId == userId);
            _context.UserPermissions.RemoveRange(existingPermissions);

            foreach (var permission in PingPermissions.RolePermissions[role])
            {
                _context.UserPermissions.Add(new UserPermission
                {
                    UserId = userId,
                    Permission = permission,
                    GrantedBy = "SYSTEM"
                });
            }

            await _context.SaveChangesAsync();
            _logger.LogInformation("Updated user {UserId} role to {Role}", userId, role);
        }

        public async Task<List<ApplicationUser>> GetAllUsersAsync()
        {
            return await _context.Users
                .Include(u => u.UserPermissions)
                .OrderBy(u => u.Email)
                .ToListAsync();
        }

        public async Task DeactivateUserAsync(string userId)
        {
            var user = await _context.Users.FindAsync(userId);
            if (user != null)
            {
                user.IsActive = false;
                await _context.SaveChangesAsync();
                _logger.LogInformation("Deactivated user {UserId}", userId);
            }
        }

        public async Task ActivateUserAsync(string userId)
        {
            var user = await _context.Users.FindAsync(userId);
            if (user != null)
            {
                user.IsActive = true;
                await _context.SaveChangesAsync();
                _logger.LogInformation("Activated user {UserId}", userId);
            }
        }
    }
}
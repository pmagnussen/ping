namespace Ping.Server.Models
{
    public class ApplicationUser
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string Email { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public DateTime? LastSignInAt { get; set; }
        public bool IsActive { get; set; } = true;
        public UserRole Role { get; set; } = UserRole.User;
        public List<string> Permissions { get; set; } = new();
        
        // Navigation properties
        public virtual ICollection<UserPermission> UserPermissions { get; set; } = new List<UserPermission>();
    }

    public enum UserRole
    {
        User = 0,
        Moderator = 1,
        Admin = 2,
        SuperAdmin = 3
    }
}

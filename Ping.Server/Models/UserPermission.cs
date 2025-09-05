namespace Ping.Server.Models
{
    public class UserPermission
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string UserId { get; set; } = string.Empty;
        public string Permission { get; set; } = string.Empty;
        public DateTime GrantedAt { get; set; } = DateTime.UtcNow;
        public string GrantedBy { get; set; } = string.Empty;
        
        // Navigation properties
        public virtual ApplicationUser User { get; set; } = null!;
    }
}
